# News Dashboard 上云 Checklist（小白版）

按顺序做，做完一项就打勾。默认你使用 Ubuntu ECS。

## A. 云资源准备

- [ ] 已创建 ECS（建议 2C4G 起步），拿到公网 IP
- [ ] 已放行安全组入站端口：
  - [ ] `22`（SSH）
  - [ ] `80`（HTTP）
  - [ ] `443`（HTTPS，可后续再开）
- [ ] （可选）已绑定域名到 ECS 公网 IP

## B. 登陆 ECS 与基础环境

- [ ] SSH 登陆

```bash
ssh <your-user>@<ecs-ip>
```

- [ ] 安装基础依赖

```bash
sudo apt update
sudo apt install -y curl git nginx
```

- [ ] 安装 Node.js（建议 20+）

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## C. 拉代码与准备目录

- [ ] 拉取项目到 ECS（替换成你的仓库地址）

```bash
cd ~
git clone https://github.com/Audic-c/News_dashboard.git my_project
cd ~/my_project
```

- [ ] 安装依赖并创建日志目录

```bash
npm ci --omit=dev
mkdir -p logs
chmod +x scripts/run-pipeline.sh
```

## D. 配置 `.env`（非常重要）

- [ ] 复制模板

```bash
cp .env.example .env
```

- [ ] 编辑 `.env`，至少确认这些键有值：
  - [ ] `NEWS_API_KEY`
  - [ ] `FEISHU_APP_ID` `FEISHU_APP_SECRET` `FEISHU_BASE_ID` `FEISHU_TABLE_ID`
  - [ ] `NOTION_*`（如要发 Notion）
  - [ ] `TELEGRAM_*`（如要发 Telegram）
  - [ ] `WECHAT_OFFICIAL_ACCOUNT_*`（如要发公众号）

- [ ] 推荐这几个默认值：
  - [ ] `NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1`
  - [ ] `PIPELINE_REFRESH_CHANNELS=json,render`
  - [ ] `PIPELINE_PUBLISH_CHANNELS=publish`
  - [ ] `PIPELINE_ENABLE_WECHAT=0`（若要发公众号改为 `1`）
  - [ ] `NEWS_OVERVIEW_SNAPSHOT_MAX_AGE_HOURS=24`

## E. 先做一次“本机测试”

- [ ] API 能启动

```bash
node server.js
```

看到 `RSS Proxy Server running` 后，另开一个终端执行：

```bash
curl -H "X-API-Key: <你的NEWS_API_KEY>" http://127.0.0.1:3000/api/health
```

成功后 `Ctrl+C` 停掉 `node server.js`。

- [ ] 预检能通过

```bash
node scripts/preflight-check.js
```

- [ ] （如启用公众号）微信凭据检查

```bash
node scripts/wechat-credential-check.js
```

## F. 安装 systemd 常驻与定时任务

> 先把下面路径里的 `cori` 改成你 ECS 上真实用户名（在 service 文件里）。

- [ ] 复制 service/timer

```bash
sudo cp deploy/ecs/systemd/news-dashboard-api.service /etc/systemd/system/
sudo cp deploy/ecs/systemd/news-dashboard-pipeline.service /etc/systemd/system/
sudo cp deploy/ecs/systemd/news-dashboard-pipeline.timer /etc/systemd/system/
sudo cp deploy/ecs/systemd/news-dashboard-healthcheck.service /etc/systemd/system/
sudo cp deploy/ecs/systemd/news-dashboard-healthcheck.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

- [ ] 启动并设置开机自启

```bash
sudo systemctl enable --now news-dashboard-api.service
sudo systemctl enable --now news-dashboard-pipeline.timer
sudo systemctl enable --now news-dashboard-healthcheck.timer
```

- [ ] 手动触发一次流水线

```bash
sudo systemctl start news-dashboard-pipeline.service
```

## G. 安装 Nginx 反代

- [ ] 复制配置并重载

```bash
sudo cp deploy/ecs/nginx/news-dashboard.conf /etc/nginx/conf.d/
sudo nginx -t
sudo systemctl reload nginx
```

- [ ] 外网访问验证

```bash
curl -H "X-API-Key: <你的NEWS_API_KEY>" http://<ecs公网IP>/api/health
```

## H. 上线后必查项（排错）

- [ ] API 服务状态

```bash
systemctl status news-dashboard-api.service --no-pager
journalctl -u news-dashboard-api.service -n 100 --no-pager
```

- [ ] 定时任务状态

```bash
systemctl list-timers | grep news-dashboard
journalctl -u news-dashboard-pipeline.service -n 100 --no-pager
```

- [ ] 项目日志

```bash
tail -n 100 ~/my_project/logs/api-service.log
tail -n 100 ~/my_project/logs/pipeline.log
tail -n 100 ~/my_project/logs/healthcheck.log
```

## I. 常见问题（快速判断）

1. `401 Unauthorized`  
检查 `NEWS_API_KEY` 与请求头 `X-API-Key` 是否一致。

2. 公众号发送失败 `40164`  
通常是微信 IP 白名单问题，把 ECS 出口 IP 加入白名单。

3. 定时没触发  
先看 `systemctl list-timers`，再看 `journalctl -u news-dashboard-pipeline.timer`。

4. 前端打不开数据  
先测：`curl http://127.0.0.1:3000/api/health`，再测外网 URL，最后看 Nginx 日志。

## J. 你现在最少要执行的 6 条命令

```bash
cd ~/my_project
npm ci --omit=dev
mkdir -p logs && chmod +x scripts/run-pipeline.sh
node scripts/preflight-check.js
sudo systemctl enable --now news-dashboard-api.service
sudo systemctl start news-dashboard-pipeline.service
```
