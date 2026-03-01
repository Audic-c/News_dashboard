const NEWS_SOURCES = {
    economist: {
        name: 'The Economist',
        color: '#d90429',
        logo: 'EC',
        category: 'Business & Politics',
        rssUrl: 'https://www.economist.com/international/rss.xml',
        alternativeUrls: [
            'https://www.economist.com/business/rss.xml',
            'https://www.economist.com/finance-and-economics/rss.xml',
            // Google News as a fallback (more reliable)
            'https://news.google.com/rss/search?q=when:24h+allinurl:economist.com&ceid=US:en&hl=en-US&gl=US'
        ],
        useAPI: false,
        sampleData: [
            { title: 'Global economic recovery gains momentum', link: 'https://www.economist.com/', pubDate: new Date().toISOString(), description: 'Economic indicators show strong recovery', thumbnail: null, categories: ['Economy'] },
            { title: 'Technology reshaping traditional industries', link: 'https://www.economist.com/', pubDate: new Date(Date.now() - 3600000).toISOString(), description: 'AI and automation drive change', thumbnail: null, categories: ['Technology'] },
            { title: 'Climate policies accelerate worldwide', link: 'https://www.economist.com/', pubDate: new Date(Date.now() - 7200000).toISOString(), description: 'New regulations take effect', thumbnail: null, categories: ['Environment'] },
            { title: 'Central banks navigate inflation', link: 'https://www.economist.com/', pubDate: new Date(Date.now() - 10800000).toISOString(), description: 'Monetary policy challenges remain', thumbnail: null, categories: ['Finance'] },
            { title: 'Trade tensions reshape supply chains', link: 'https://www.economist.com/', pubDate: new Date(Date.now() - 14400000).toISOString(), description: 'Global commerce faces disruption', thumbnail: null, categories: ['Trade'] }
        ]
    },
    ft: {
        name: 'Financial Times',
        color: '#fff1e5',
        textColor: '#333',
        logo: 'FT',
        category: 'Finance & Markets',
        rssUrl: 'https://www.ft.com/rss/home/uk'
    },
    bloomberg: {
        name: 'Bloomberg',
        color: '#0057b8',
        logo: 'BG',
        category: 'Business & Markets',
        rssUrl: 'https://feeds.bloomberg.com/markets/news.rss'
    },
    nyt: {
        name: 'The New York Times',
        color: '#000000',
        logo: 'NYT',
        category: 'General News',
        rssUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'
    },
    bbc: {
        name: 'BBC News',
        color: '#bb1919',
        logo: 'BBC',
        category: 'World News',
        rssUrl: 'http://newsrss.bbc.co.uk/rss/newsonline_uk_edition/front_page/rss.xml'
    },
    reuters: {
        name: 'Reuters',
        color: '#ff8000',
        logo: 'RE',
        category: 'World News',
        // Reuters stopped official RSS (June 2020), use Google News RSS as a proxy
        rssUrl: 'https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com&ceid=US:en&hl=en-US&gl=US',
        alternativeUrls: [
            'https://news.google.com/rss/search?q=site:reuters.com&ceid=US:en&hl=en-US&gl=US'
        ],
        useAPI: false,
        isGoogleNewsProxy: true
    },
    scmp: {
        name: 'South China Morning Post',
        color: '#1e3a8a',
        logo: 'SC',
        category: 'Asia News',
        rssUrl: 'https://www.scmp.com/rss/91/feed'
    },
    'mit-tr': {
        name: 'MIT Technology Review',
        color: '#00b894',
        logo: 'TR',
        category: 'Technology',
        rssUrl: 'https://www.technologyreview.com/feed/'
    },
    newyorker: {
        name: 'The New Yorker',
        color: '#ff6b6b',
        logo: 'NY',
        category: 'Culture & Arts',
        rssUrl: 'https://www.newyorker.com/feed/news'
    },
    guardian: {
        name: 'The Guardian',
        color: '#052962',
        logo: 'GU',
        category: 'World & Opinion',
        rssUrl: 'https://www.theguardian.com/international/rss'
    },
    wsj: {
        name: 'Wall Street Journal',
        color: '#003366',
        logo: 'WSJ',
        category: 'Business & Finance',
        rssUrl: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'
    },
    feishu: {
        name: '飞书收藏',
        color: '#3370FF',
        textColor: '#fff',
        logo: 'FS',
        category: 'My Collection',
        url: 'https://ncnr408dbok6.feishu.cn/base/R71JbhzOeaNzbbskmZrcxXFyn5f',
        fetcher: 'feishu'
    }
};

module.exports = {
    NEWS_SOURCES
};
