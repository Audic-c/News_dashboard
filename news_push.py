import os
import sys
import time
import random
import difflib
import argparse
import logging
import requests
from pathlib import Path
from datetime import datetime
import re

# 添加路径
current_dir = Path(__file__).resolve().parent
project_root = current_dir.parent
src_dir = project_root / "src"
sys.path.insert(0, str(src_dir))
sys.path.insert(0, str(project_root))

from src.shared.human_simulation import (
    random_sleep, human_click, human_move_to, human_type_or_paste, 
    human_press, human_hotkey, startup_delay
)

try:
    import pyautogui
    import pyperclip
    from PIL import Image, ImageGrab
    import cv2
    import numpy as np
except ImportError:
    print("请安装依赖: pip install pyautogui pyperclip Pillow opencv-python requests")
    sys.exit(1)

# 导入自定义模块
from src.modules.window_control.window_manager import WindowManager
from src.modules.ocr_engines.windows_ocr import WindowsOcrEngine
from src.modules.ui_detection.config import REGIONS, INTERACTION_PARAMS, crop_region, get_region_coords

# 导入流程操作器 (保持兼容性)
from src.modules.workflow.contact_list_operator import ContactListOperator
from src.modules.workflow.chat_area_operator import ChatAreaOperator
from src.modules.workflow.input_area_operator import InputAreaOperator

# ─── 全局状态 ──────────────────────────────────────────────────
SENT_HISTORY = set()

# ─── 日志系统 ──────────────────────────────────────────────────
class DualLogger:
    def __init__(self, filename="log.md"):
        self.terminal = sys.stdout
        # 确保目录存在
        log_path = Path(filename)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_file = open(filename, "a", encoding="utf-8")
        
    def write(self, message):
        self.terminal.write(message)
        self.log_file.write(message)
        self.log_file.flush()
        
    def flush(self):
        self.terminal.flush()
        self.log_file.flush()

def print_header(text):
    print("\n" + "=" * 70)
    print(f"  {text}")
    print("=" * 70 + "\n")

def print_step(step, text):
    print(f"[{step}] {text}")

def print_result(success, message):
    symbol = "✅" if success else "❌"
    print(f"  {symbol} {message}")

def log_push_status(contact_name, status, details=""):
    """记录分发审计日志到 Markdown 表格"""
    audit_file = current_dir / "logs" / "push_audit.md"
    audit_file.parent.mkdir(parents=True, exist_ok=True)
    
    # 如果文件不存在，写入表头
    if not audit_file.exists():
        with open(audit_file, "w", encoding="utf-8") as f:
            f.write("# News Push Audit Log\n\n")
            f.write("| 时间 | 联系人/群组 | 状态 | 详情 |\n")
            f.write("| --- | --- | --- | --- |\n")
            
    with open(audit_file, "a", encoding="utf-8") as f:
        f.write(f"| {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | {contact_name} | {status} | {details} |\n")

# ─── 核心交互逻辑 (Restore from session) ───────────────────────────

def get_random_point_in_rect(rect, relative_to_window_pos=None, margin_override=None, region_name=None):
    """
    获取区域内的随机点击点，支持安全边距和 Y 轴偏置
    """
    if relative_to_window_pos:
        wx, wy, ww, wh = relative_to_window_pos
        x1, y1, x2, y2 = rect
        abs_x1 = wx + int(x1 * ww)
        abs_y1 = wy + int(y1 * wh)
        abs_x2 = wx + int(x2 * ww)
        abs_y2 = wy + int(y2 * wh)
    else:
        abs_x1, abs_y1, abs_x2, abs_y2 = rect

    # 确定边距比例
    if margin_override is not None:
        margin_ratio = margin_override
    elif region_name:
        region_margins = INTERACTION_PARAMS.get('region_margins', {})
        # 优先查找特定区域边距，否则使用全局 click_safe_margin
        margin_ratio = region_margins.get(region_name, INTERACTION_PARAMS.get('click_safe_margin', 0.1))
    else:
        margin_ratio = INTERACTION_PARAMS.get('click_safe_margin', 0.1)
    
    w = abs_x2 - abs_x1
    h = abs_y2 - abs_y1
    margin_x = int(w * margin_ratio)
    margin_y = int(h * margin_ratio)
    
    # 随机 X
    rand_x = random.randint(abs_x1 + margin_x, abs_x2 - margin_x)
    
    # 检查是否有 Y 轴偏置 (针对 search_bar)
    y_bias = INTERACTION_PARAMS.get('region_margins', {}).get(f'{region_name}_y_bias', None) if region_name else None
    
    if y_bias is not None:
        # 使用幂函数实现偏向底部的分布
        t = random.random() ** y_bias
        rand_y = int(abs_y1 + margin_y + t * (h - 2 * margin_y))
    else:
        rand_y = random.randint(abs_y1 + margin_y, abs_y2 - margin_y)
    
    return rand_x, rand_y

def is_in_history(name, threshold=0.8):
    """使用模糊匹配判断是否在记录中"""
    if not name:
        return False
    for sent_name in SENT_HISTORY:
        similarity = difflib.SequenceMatcher(None, name, sent_name).ratio()
        if similarity >= threshold:
            return True
    return False

def get_current_contact_name(header_ocr: WindowsOcrEngine, manager: WindowManager, retries=2, retry_click_pos=None):
    """
    获取当前聊天对象名称 (增强版：支持二次确认/重试)
    """
    for attempt in range(retries + 1):
        if attempt > 0:
            # 逻辑：如果第一次失败，且有点击坐标，尝试二次点击激活
            if retry_click_pos and attempt == 1:
                print(f"  ⚠️ Header 识别失败，尝试二次点击重试 ({retry_click_pos})...")
                human_click(*retry_click_pos, duration=0.5)
                # 点击后移开鼠标，防止遮挡
                human_move_to(retry_click_pos[0] + 300, retry_click_pos[1], duration=0.4)
                random_sleep(1.2)
            else:
                # 仅等待扫描延迟
                random_sleep(0.8)
            
        screenshot = manager.capture_window()
        if not screenshot: continue
        
        # 裁剪标题栏区域
        header_img = crop_region(screenshot, 'chat_header')
        results = header_ocr.recognize(header_img)
        
        if results and results.lines:
            # 提取文本并清理 (移除群人数及其括号)
            text = results.lines[0].text.strip()
            text = re.sub(r'\s*[(\uff08]\d+[)\uff09]$', '', text) 
            return text
            
        if attempt < retries and not retry_click_pos:
            print(f"  ⚠️ Header 识别失败 (第 {attempt+1} 次)，正在重试...")
            
    return None

def verify_sent_message(chat_op: ChatAreaOperator, manager: WindowManager, retries=3):
    """
    验证消息是否发送成功 (基于位置对齐判定)
    """
    for i in range(retries):
        if i > 0:
            random_sleep(1.5) # 给 UI 渲染和图片显示留出时间
            
        screenshot = manager.capture_window()
        if not screenshot: continue
        
        screenshot_cv2 = cv2.cvtColor(np.array(screenshot), cv2.COLOR_RGB2BGR)
        
        # [Core Update] 底层 detector 已支持基于对齐判定 side
        result = chat_op.detect_bubbles(screenshot_cv2)
        messages = result.get('messages', [])
        
        if messages:
            # 只要最后一条消息对齐在右侧，即代表发送成功 (不再强制绿泡)
            last_msg = messages[-1]
            if last_msg.get('side') == 'right':
                return True
                
        if i < retries - 1:
            print(f"  ⏳ 等待确认 (轮询 {i+1}/{retries})...")
            
    return False

# ─── 推送业务 ──────────────────────────────────────────────────

# 配置端口 (支持从环境变量或硬编码修改)
PORT = 3000
BASE_URL = f"http://localhost:{PORT}"

def trigger_news_build():
    """触发后端重新生成新闻 (Remote)"""
    print_step("步骤", f"触发重新生成 (Remote: {BASE_URL}/api/send-brief)...")
    try:
        url = f"{BASE_URL}/api/send-brief"
        # 默认推送到所有渠道
        resp = requests.post(url, json={"channels": "all"}, timeout=30)
        if resp.status_code == 200:
            print_result(True, "重新生成任务已触发")
            return True
        print_result(False, f"触发失败: HTTP {resp.status_code}")
    except Exception as e:
        print_result(False, f"请求异常: {e}")
    return False

def fetch_news_image(save_path: str = "news.png"):
    """获取最新新闻图片"""
    print_step("步骤", f"获取新闻图片 ({BASE_URL})...")
    try:
        # 添加时间戳参数避免缓存
        timestamp = int(time.time() * 1000)
        url = f"{BASE_URL}/api/news-overview-image?t={timestamp}"
        resp = requests.get(url, timeout=15, headers={'Cache-Control': 'no-cache'})
        if resp.status_code == 200:
            with open(save_path, "wb") as f:
                f.write(resp.content)
            print_result(True, f"图片保存成功: {save_path} ({len(resp.content)/1024:.1f} KB)")
            return True
        print_result(False, f"获取失败: HTTP {resp.status_code}")
    except Exception as e:
        print_result(False, f"获取异常: {e}")
    return False

def copy_image_to_clipboard(image_path: str):
    """将图片内容写入剪贴板 (Win32 API)"""
    try:
        from io import BytesIO
        import win32clipboard
        
        image = Image.open(image_path)
        output = BytesIO()
        image.convert("RGB").save(output, "BMP")
        data = output.getvalue()[14:]  # 去掉 14 字节的 BMP 头部
        output.close()
        
        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32clipboard.CF_DIB, data)
        win32clipboard.CloseClipboard()
        return True
    except Exception as e:
        print_result(False, f"图片写入剪贴板失败: {e}")
        return False

# ─── 推送流程 (Restore from session) ───────────────────────────

def main_loop_send(manager, header_ocr, chat_op, max_contacts=10, image_path="news.png"):
    """
    默认分发模式: 从第一个开始，按 ↓ 切换
    """
    if not manager.ensure_window():
        return
    
    win_info = manager.get_window_info()
    win_pos = (win_info['left'], win_info['top'], win_info['width'], win_info['height'])
    
    d_click = INTERACTION_PARAMS['delay_after_click']
    d_ocr = INTERACTION_PARAMS['delay_ocr_wait']
    d_send = (10.0, 15.0)  # 使用会话中指定的长时间等待
    
    print_header(f"开始默认分发 (前 {max_contacts} 位)")
    
    # 0. 点击第一个联系人 (使用拟人化扇形分布)
    print_step("初始化", "选中联系人列表首位...")
    fx, fy = get_random_point_in_rect(REGIONS['contact_list'], win_pos)
    # 强制瞄准顶部第一个
    fy = win_info['top'] + int(REGIONS['contact_list'][1] * win_info['height']) + 30
    
    base_fx, base_fy = fx, fy # 基础坐标
    
    # [Anti-Bot] 极坐标生成：右下方 90 度扇形区 (越远越容易点击)
    max_r = 40.0
    r = random.triangular(0, max_r, max_r)
    theta = random.uniform(0, np.pi / 2)
    click_x = int(base_fx + r * np.cos(theta))
    click_y = int(base_fy + r * np.sin(theta))
    
    human_click(click_x, click_y, duration=random.uniform(0.8, 1.2))
    
    # [Anti-Bot] 点击收件人后移开鼠标到安全区，给渲染预留时间
    cx1, cy1, cx2, cy2 = get_region_coords('chat_area', win_info['width'], win_info['height'])
    safe_x = win_info['left'] + cx1 + (cx2 - cx1) * 0.5
    safe_y = win_info['top'] + cy1 + (cy2 - cy1) * 0.5
    human_move_to(safe_x, safe_y, duration=random.uniform(0.8, 1.2))
    
    # [UI-Wait] 等待微信渲染聊天界面
    time.sleep(1.2)
    
    success_count = 0
    fail_count = 0
    first_contact_y = win_info['top'] + int(REGIONS['contact_list'][1] * win_info['height']) + 35
    row_height = 65 # 微信默认联系人行高估算
    
    current_logical_row = 1  # 追踪我们在原始列表中的逻辑位置
    
    for i in range(max_contacts):
        # 估算当前联系人在屏幕上的点击位置 (用于 OCR 失败时的重试点击)
        screen_y = first_contact_y + (min(i, 8) * row_height) # 这里取 min(i,8) 是因为超过屏幕会滚动，目前先处理首屏 15 位
        current_click_pos = (fx, screen_y)

        print(f"\n--- [{i+1}/{max_contacts}] | 逻辑位置: 第 {current_logical_row} 行 ---")
        
        # 1. 识别 (传入当前估算位置用于重试)
        contact_name = get_current_contact_name(header_ocr, manager, retry_click_pos=current_click_pos)
        sent_this_step = False
        
        if not contact_name:
            print("  ⚠️ 无法识别标题, 尝试跳过")
        else:
            print(f"  👤 联系人: [{contact_name}]")
            # 2. 去重
            if is_in_history(contact_name):
                print(f"  ⏭️ 已发送过, 跳过")
            else:
                # 3. 发送
                # 关键：每次发送前重新写剪贴板
                copy_image_to_clipboard(image_path)
                
                # 激活输入框
                ix, iy = get_random_point_in_rect(REGIONS['input_area'], win_pos)
                # [Anti-Bot] 定位到输入区，耗时 0.8-1.2s
                human_click(ix, iy, duration=random.uniform(0.8, 1.2))
                random_sleep(0.4) 

                # 粘贴并发送
                human_hotkey('ctrl', 'v')
                time.sleep(random.uniform(0.7, 1.5))
                
                # [Anti-Bot] 发送前的拟人化停顿
                random_sleep(0.7, jitter=0.3, min_val=0.4)
                human_press('enter')
                
                SENT_HISTORY.add(contact_name)
                
                # 等待上传确认
                wait_time = random.uniform(*d_send)
                print(f"  ⏳ 等待上传/确认 ({wait_time:.1f}s)...")
                time.sleep(wait_time)
                
                # 4. 验证
                if verify_sent_message(chat_op, manager):
                    print_result(True, f"发送至 {contact_name} 成功")
                    log_push_status(contact_name, "Success")
                    success_count += 1
                    sent_this_step = True
                else:
                    print_result(False, f"验证失败: {contact_name}")
                    log_push_status(contact_name, "Failed", "Verification failed")
                    fail_count += 1
            
        # 切换下一个 (核心旋转算法)
        if i < max_contacts - 1:
            if sent_this_step:
                # 微信特性：发送成功后，该联系人会跳回 Top 1 位置
                # 我们需要从 Top 1 开始，向下移动 current_logical_row 次，以到达原本的下一个目标
                print_step("导航", f"检测到位置重排，正在从顶部下移 {current_logical_row} 次寻找新目标...")
                # 先点一下顶部（或者 Home 键）确保在第一行，但发送后默认就在第一行
                for _ in range(current_logical_row):
                    human_press('down')
                    time.sleep(random.uniform(0.12, 0.25))
            else:
                # 未发送（跳过/失败/无法识别），位置没变，只需下移 1 次
                print_step("导航", "位置未变，直接下移 1 次...")
                human_press('down')
            
            current_logical_row += 1
            time.sleep(random.uniform(*d_ocr))
            
    print_header("分发完成报告")
    print(f"  ✅ 成功: {success_count}\n  ⚠️ 失败: {fail_count}\n  ⏭️ 跳过/重复: {max_contacts - success_count - fail_count}")

def search_and_send(manager, header_ocr, chat_op, target, image_path="news.png"):
    """
    搜索模式: 点击搜索栏 -> 输入 -> 发送
    """
    if not manager.ensure_window():
        return
        
    win_info = manager.get_window_info()
    win_pos = (win_info['left'], win_info['top'], win_info['width'], win_info['height'])
    
    print_header(f"定向分发 -> {target}")
    
    # 1. 点击搜索栏 (使用 3% 安全边距)
    print_step("步骤", "点击搜索栏...")
    sx, sy = get_random_point_in_rect(REGIONS['search_bar'], win_pos, region_name='search_bar')
    human_click(sx, sy, duration=random.uniform(0.8, 1.2))
    random_sleep(0.4)
    
    # 2. 清理并输入
    human_hotkey('ctrl', 'a')
    human_press('backspace')
    random_sleep(0.1)
    human_type_or_paste(target)
    
    # 等待搜索结果
    delay_search = INTERACTION_PARAMS.get('delay_after_search', (2.0, 3.0))
    time.sleep(random.uniform(*delay_search))
    
    # 回车选中
    human_press('enter')
    random_sleep(1.0)
    
    # 3. 发送图片
    # 重新写剪贴板 (防止 target 名字留在里面)
    copy_image_to_clipboard(image_path)
    
    ix, iy = get_random_point_in_rect(REGIONS['input_area'], win_pos)
    human_click(ix, iy, duration=random.uniform(0.8, 1.2))
    random_sleep(0.4)

    human_hotkey('ctrl', 'v')
    random_sleep(1.0)
    
    # [Anti-Bot] 发送前停顿
    random_sleep(0.7, jitter=0.3, min_val=0.4)
    human_press('enter')

    print(f"  ⏳ 等待发送验证 (15s)...")
    random_sleep(15, jitter=0.15)
    
    if verify_sent_message(chat_op, manager):
        print_result(True, f"发送至 {target} 成功")
        log_push_status(target, "Success", "Search & Send mode")
    else:
        print_result(False, f"验证未通过")
        log_push_status(target, "Failed", "Search & Send mode verification failed")

# ─── 主函数 ──────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="News Push Tool (Enhanced)")
    parser.add_argument("-n", "--count", type=int, default=15, help="默认模式推送数量")
    parser.add_argument("-t", "--target", type=str, help="定向推送目标名称")
    parser.add_argument("-i", "--image", type=str, default="news.png", help="图片路径")
    parser.add_argument("-p", "--port", type=int, default=3000, help="后端服务器端口 (默认3000)")
    parser.add_argument("--trigger", action="store_true", help="是否先触发后端清空缓存/构建任务")
    args = parser.parse_args()

    # 日志初始化
    log_dir = current_dir / "logs"
    log_file = log_dir / f"push_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    sys.stdout = DualLogger(str(log_file))

    # 更新全局端口变量
    global PORT, BASE_URL
    PORT = args.port
    BASE_URL = f"http://localhost:{PORT}"

    print_header("News Overview 推送工具 (会话补全版)")
    
    if args.trigger:
        if not trigger_news_build():
            print("  ⚠️ 触发失败 (API 500/Timeout)，将尝试使用服务器现有数据继续...")
        else:
            # 给构建一点时间
            random_sleep(5, jitter=0.15)

    # 获取/检查图片
    image_path = args.image
    # 强制重新下载最新图片（避免本地缓存）
    if args.trigger:
        # 触发构建后必须重新下载
        if not fetch_news_image(image_path):
            if not os.path.exists(image_path):
                print("未找到图片且无法从服务器拉取，退出。")
                return
    else:
        # 即使没有 --trigger，也尝试更新图片
        print_step("检查", "尝试获取最新图片...")
        if not fetch_news_image(image_path):
            # 如果下载失败，检查本地是否有备用
            if not os.path.exists(image_path):
                print("未找到图片且无法从服务器拉取，退出。")
                return
            else:
                print("  ⚠️ 使用本地缓存图片（可能不是最新）")
    
    # 初始化
    manager = WindowManager()
    header_ocr = WindowsOcrEngine()
    
    info = manager.ensure_window()
    if not info: return

    startup_delay(3, 8)

    info = manager.get_window_info()
    chat_op = ChatAreaOperator(REGIONS['chat_area'], (info['width'], info['height']))

    if args.target:
        search_and_send(manager, header_ocr, chat_op, args.target, image_path)
    else:
        main_loop_send(manager, header_ocr, chat_op, args.count, image_path)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[!] 中断")
    except Exception as e:
        print(f"\n[!] 异常: {e}")
        import traceback
        traceback.print_exc()
