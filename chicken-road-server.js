const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

// ============ 服务器配置 ============
const CONFIG = {
    // JWT配置
    JWT_ONE_TIME_USE: false,  // 是否启用一次性使用模式 (设为false允许重复使用)
    JWT_EXPIRE_HOURS: 24,     // JWT过期时间（小时）
    SESSION_CLEANUP_HOURS: 1, // 会话清理间隔（小时）

    // 服务器配置
    PORT: 8001, // 统一端口，合并local-server功能
    CORS_ORIGIN: "*",

    // 调试模式
    DEBUG_MODE: true,         // 启用调试日志
    ENABLE_DEBUG_ENDPOINTS: true,  // 启用调试端点

    // 默认货币配置
    DEFAULT_CURRENCY: "USD"   // 默认货币，可被前端auth参数覆盖
};

// ============ 全局货币配置 ============
// 存储当前服务器使用的货币设置
let serverCurrency = CONFIG.DEFAULT_CURRENCY;

// 货币配置映射
const currencyConfigs = {
    "PHP": {
        betPresets: ["0.5", "1", "2", "7"],
        minBetAmount: "0.01",
        maxBetAmount: "200.00",
        maxWinAmount: "10000.00",
        defaultBetAmount: "0.600000000000000000",
        betRanges: ["0.01", "200.00"]
    },
    "USD": {
        betPresets: ["0.1", "0.2", "0.5", "1"],
        minBetAmount: "0.01",
        maxBetAmount: "50.00",
        maxWinAmount: "2500.00",
        defaultBetAmount: "0.100000000000000000",
        betRanges: ["0.01", "50.00"]
    },
    "EUR": {
        betPresets: ["0.1", "0.2", "0.5", "1"],
        minBetAmount: "0.01",
        maxBetAmount: "50.00",
        maxWinAmount: "2500.00",
        defaultBetAmount: "0.100000000000000000",
        betRanges: ["0.01", "50.00"]
    }
};

// 获取当前货币配置
const getCurrentCurrencyConfig = () => {
    return currencyConfigs[serverCurrency] || currencyConfigs[CONFIG.DEFAULT_CURRENCY];
};

// 设置服务器货币
const setServerCurrency = (currency) => {
    if (currencyConfigs[currency]) {
        serverCurrency = currency;
        console.log(`💰 服务器货币设置为: ${currency}`);
        return true;
    } else {
        console.log(`⚠️  不支持的货币: ${currency}, 使用默认货币: ${CONFIG.DEFAULT_CURRENCY}`);
        serverCurrency = CONFIG.DEFAULT_CURRENCY;
        return false;
    }
};

const app = express();
const httpServer = createServer(app);

// 请求日志中间件 - 在所有其他中间件之前
app.use((req, res, next) => {
    // 记录请求开始时间
    req.startTime = Date.now();

    // 打印请求开始日志
    console.log('\n=== 📨 REQUEST START ===');
    console.log(`时间: ${new Date().toISOString()}`);
    console.log(`方法: ${req.method}`);
    console.log(`路径: ${req.path}`);
    console.log(`完整URL: ${req.protocol}://${req.get('Host')}${req.originalUrl}`);
    console.log(`来源IP: ${req.ip || req.connection.remoteAddress}`);
    console.log(`User-Agent: ${req.get('User-Agent') || 'Unknown'}`);

    // 打印请求头
    console.log(`📤 请求头:`, {
        'Content-Type': req.get('Content-Type'),
        'Authorization': req.get('Authorization') ? '[HIDDEN]' : undefined,
        'Accept': req.get('Accept'),
        'Origin': req.get('Origin'),
        'Referer': req.get('Referer')
    });

    // 打印查询参数
    if (Object.keys(req.query).length > 0) {
        console.log(`❓ 查询参数:`, req.query);
    }

    // 拦截响应结束事件来记录响应日志
    const originalSend = res.send;
    res.send = function (data) {
        const endTime = Date.now();
        const duration = endTime - req.startTime;

        console.log('\n=== 📩 RESPONSE END ===');
        console.log(`响应时间: ${new Date().toISOString()}`);
        console.log(`处理耗时: ${duration}ms`);
        console.log(`状态码: ${res.statusCode}`);
        console.log(`响应大小: ${data ? Buffer.byteLength(data, 'utf8') : 0} bytes`);

        // 如果是JSON响应且状态码不是200，记录响应内容（用于调试）
        if (res.statusCode !== 200 && res.get('Content-Type')?.includes('application/json')) {
            try {
                const jsonData = JSON.parse(data);
                console.log(`⚠️  错误响应:`, jsonData);
            } catch (e) {
                console.log(`⚠️  响应内容:`, data?.toString()?.substring(0, 200));
            }
        }

        console.log('=== ✅ REQUEST COMPLETE ===\n');

        // 调用原始的send方法
        return originalSend.call(this, data);
    };

    next();
});

// 添加CORS支持和JSON解析
app.use((req, res, next) => {
    // 匹配真实 API 的 CORS 头
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LANG, Pragma, Cache-Control, Upgrade, Connection, Cookie, x-requested-with, X-Forwarded-Proto, X-Forwarded-Host');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Expose-Headers', 'Country-Code');
    res.header('Access-Control-Max-Age', '1728000');

    // 支持Cloudflare代理的headers
    if (req.get('x-forwarded-proto') === 'https') {
        res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 记录请求体（在JSON解析之后）
app.use((req, res, next) => {
    if (req.body && Object.keys(req.body).length > 0) {
        console.log(`📦 请求体:`, req.body);
    }
    next();
});

// JWT 密钥
const JWT_SECRET = 'your-secret-key';

// 存储已使用的token，模拟一次性使用机制
const usedTokens = new Set();
const activeSessions = new Map();

// 生成动态JWT token
const generateJWT = (userData) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        userId: userData.userId || "e073e0e40c704b5b9544cc8b5e1c61ef",
        nickname: userData.nickname || "9K8708359465",
        balance: userData.balance || "21.295",
        currency: userData.currency || serverCurrency,
        operator: "63565b4f-abbe-4850-9dac-9d50e5dc4283",
        operatorId: "63565b4f-abbe-4850-9dac-9d50e5dc4283",
        meta: null,
        gameAvatar: null,
        sessionToken: `${userData.userId || "e073e0e40c704b5b9544cc8b5e1c61ef"}_inout`,
        iat: now,
        exp: now + (CONFIG.JWT_EXPIRE_HOURS * 3600)
    };

    return jwt.sign(payload, JWT_SECRET);
};

// 验证JWT token
const verifyJWT = (token) => {
    try {
        // 根据配置决定是否检查一次性使用
        if (CONFIG.JWT_ONE_TIME_USE && usedTokens.has(token)) {
            throw new Error('Token already used (one-time use mode enabled)');
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        // 检查是否过期
        const now = Math.floor(Date.now() / 1000);
        if (decoded.exp < now) {
            throw new Error('Token expired');
        }

        // 只在启用一次性使用模式时标记token为已使用
        if (CONFIG.JWT_ONE_TIME_USE) {
            usedTokens.add(token);
            if (CONFIG.DEBUG_MODE) {
                console.log(`🔒 Token标记为已使用 (一次性模式): ${token.substring(0, 20)}...`);
            }
        }

        return decoded;
    } catch (err) {
        throw new Error('Invalid token: ' + err.message);
    }
};

// 创建 Socket.IO 服务器
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 20000,
    pingInterval: 25000,
    maxPayload: 1000000,
    path: '/io/'
});

// ============ 东南亚常用英文名字配置 ============
const southeastAsianNames = {
    // 东南亚男性常用英文名
    maleNames: [
        // 泰国常用英文名
        "Akira", "Alex", "Andrew", "Anthony", "Ben", "Bobby", "Brian", "Charlie", "Chris", "Daniel",
        "David", "Eddie", "Felix", "Frank", "George", "Henry", "Jack", "James", "John", "Kevin",
        "Leo", "Mark", "Max", "Michael", "Nick", "Oscar", "Paul", "Peter", "Ray", "Sam",
        "Tony", "Victor", "William", "Zen", "Adam", "Alan", "Arthur", "Austin", "Barry", "Bruce",

        // 越南常用英文名
        "Aaron", "Albert", "Allen", "Andy", "Angelo", "Arnold", "Bernard", "Billy", "Carl", "Calvin",
        "Dean", "Dennis", "Derek", "Doug", "Earl", "Edgar", "Edwin", "Eric", "Eugene", "Fred",
        "Gary", "Glen", "Harold", "Harvey", "Ivan", "Jacob", "Jake", "Jerry", "Jim", "Joe",
        "Jordan", "Keith", "Ken", "Larry", "Louis", "Luke", "Martin", "Matt", "Nathan", "Neil",

        // 菲律宾常用英文名
        "Adrian", "Austin", "Blake", "Brad", "Brett", "Carlo", "Craig", "Dale", "Dave", "Drew",
        "Evan", "Grant", "Greg", "Ian", "Jason", "Jeff", "Josh", "Kyle", "Lance", "Leon",
        "Mason", "Owen", "Rick", "Rob", "Ross", "Ryan", "Sean", "Steve", "Tom", "Tyler",
        "Wayne", "Zach", "Angelo", "Benny", "Carlos", "Diego", "Felix", "Hugo", "Ivan", "Jose",

        // 印尼/马来常用英文名
        "Ahmad", "Ali", "Arif", "Budi", "Dedi", "Edi", "Faris", "Hadi", "Irwan", "Joko",
        "Kurnia", "Lucky", "Made", "Nanda", "Omar", "Putra", "Rama", "Sandi", "Taufik", "Umar",
        "Vino", "Wahyu", "Yudi", "Zaki", "Andi", "Bobby", "Chandra", "Dimas", "Eka", "Ferry"
    ],

    // 东南亚女性常用英文名
    femaleNames: [
        // 泰国常用英文名
        "Amy", "Anna", "Belle", "Cake", "Charm", "Dear", "Emma", "Fai", "Gift", "Grace",
        "Ice", "Jane", "Joy", "Kate", "Lisa", "Love", "May", "Nice", "Noon", "Pam",
        "Pink", "Ploy", "Rain", "Rose", "Sara", "Smile", "Su", "Tina", "View", "Wan",
        "Yui", "Zen", "Alice", "Annie", "Candy", "Coco", "Dove", "Fern", "Holly", "Iris",

        // 越南常用英文名
        "Bella", "Cindy", "Diana", "Elena", "Fiona", "Gina", "Helen", "Ivy", "Jenny", "Kelly",
        "Lily", "Mia", "Nina", "Olivia", "Penny", "Queen", "Ruby", "Sophia", "Tiffany", "Una",
        "Vivian", "Wendy", "Xenia", "Yvonne", "Zoe", "Andrea", "Betty", "Clara", "Donna", "Eva",
        "Faith", "Gloria", "Hannah", "Irene", "Julia", "Karen", "Linda", "Monica", "Nancy", "Paula",

        // 菲律宾常用英文名
        "Angel", "Bianca", "Carla", "Dina", "Ella", "Faith", "Gail", "Hope", "Ina", "Jessa",
        "Kim", "Lea", "Mae", "Nica", "Paula", "Rica", "Shea", "Tessa", "Vina", "Zia",
        "Aileen", "Bea", "Cathy", "Dara", "Erica", "Gigi", "Joy", "Kris", "Liza", "Marge",
        "Nora", "Patty", "Rita", "Shane", "Tanya", "Venus", "Wanda", "Yasmin", "Zara", "April",

        // 印尼/马来常用英文名
        "Ayu", "Dewi", "Eka", "Fitri", "Indira", "Kartika", "Lestari", "Maya", "Novi", "Putri",
        "Rina", "Sari", "Tari", "Uci", "Vera", "Wulan", "Yanti", "Zahra", "Anita", "Bunga",
        "Citra", "Diah", "Elsa", "Fransiska", "Gita", "Hana", "Intan", "Jessica", "Kirana", "Luna"
    ],

    // 东南亚常用姓氏
    surnames: [
        // 泰国姓氏
        "Tanaka", "Saito", "Wong", "Lim", "Tan", "Lee", "Chan", "Chen", "Wang", "Yang",
        "Nguyen", "Tran", "Le", "Pham", "Hoang", "Vu", "Vo", "Dang", "Bui", "Do",
        "Krishnan", "Kumar", "Singh", "Sharma", "Patel", "Gupta", "Agarwal", "Jain", "Mehta", "Shah",
        "Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Garcia", "Mendoza", "Torres", "Flores", "Ramos",
        "Sari", "Wijaya", "Kusuma", "Pratama", "Utama", "Santoso", "Hartono", "Gunawan", "Setiawan", "Handoko"
    ]
};

// 东南亚国家代码
const southeastAsianCountries = [
    "IN", "US", "GB", "BD", "TH", "SG", "MY", "PH", "ID", "VN"
];

// ============ 随机数据生成函数 ============

// 生成随机在线人数 (30,000 - 40,000)
function generateRandomOnlineCount() {
    const total = Math.floor(Math.random() * (40000 - 30000 + 1)) + 30000;

    // 基于原始数据的比例分配，添加随机波动
    const gameMode = {
        "chicken-road-two": Math.floor(total * (0.32 + Math.random() * 0.06)), // 32-38%
        "chicken-road": Math.floor(total * (0.35 + Math.random() * 0.08)), // 35-43%
        "squid-game": Math.floor(total * (0.08 + Math.random() * 0.04)), // 8-12%
        "chicken-road-97": Math.floor(total * (0.03 + Math.random() * 0.02)), // 3-5%
        "hamster-run": Math.floor(total * (0.10 + Math.random() * 0.04)), // 10-14%
        "crash": Math.floor(Math.random() * 60 + 20), // 20-80
        "forest-fortune-v1": Math.floor(Math.random() * 150 + 80), // 80-230
        "wheel": Math.floor(Math.random() * 200 + 150), // 150-350
        "plinko-aztec": Math.floor(Math.random() * 120 + 80), // 80-200
        "limbo": Math.floor(Math.random() * 15 + 3), // 3-18
        "new-double": Math.floor(Math.random() * 50 + 20), // 20-70
        "ballonix": Math.floor(Math.random() * 120 + 80), // 80-200
        "diver": Math.floor(Math.random() * 100 + 60), // 60-160
        "aviafly": Math.floor(Math.random() * 80 + 50), // 50-130
        "unknown": Math.floor(Math.random() * 30 + 10), // 10-40
        "stairs": Math.floor(Math.random() * 25 + 10), // 10-35
        "twist": Math.floor(Math.random() * 400 + 300), // 300-700
        "chicken-road-1xbet": Math.floor(Math.random() * 100 + 80), // 80-180
        "platform-mines-topx": Math.floor(Math.random() * 10 + 2), // 2-12
        "triple": Math.floor(Math.random() * 20 + 8), // 8-28
        "sugar-daddy": Math.floor(Math.random() * 70 + 50), // 50-120
        "penalty-unlimited": Math.floor(Math.random() * 120 + 80), // 80-200
        "lucky-mines": Math.floor(Math.random() * 70 + 50), // 50-120
        "platform-mines": Math.floor(Math.random() * 100 + 80), // 80-180
        "cryptos": Math.floor(Math.random() * 20 + 8), // 8-28
        "bubbles": Math.floor(Math.random() * 20 + 8), // 8-28
        "coinflip": Math.floor(Math.random() * 25 + 10), // 10-35
        "goblin-tower": Math.floor(Math.random() * 12 + 5), // 5-17
        "new-hilo": Math.floor(Math.random() * 15 + 8), // 8-23
        "roulette": Math.floor(Math.random() * 50 + 30), // 30-80
        "hot-mines": Math.floor(Math.random() * 18 + 8), // 8-26
        "joker-poker": Math.floor(Math.random() * 12 + 5), // 5-17
        "jogo-do-bicho": Math.floor(Math.random() * 12 + 5), // 5-17
        "tower": Math.floor(Math.random() * 30 + 15), // 15-45
        "plinko": Math.floor(Math.random() * 90 + 70), // 70-160
        "lucky-captain": Math.floor(Math.random() * 10 + 3), // 3-13
        "keno": Math.floor(Math.random() * 10 + 3), // 3-13
        "chicken-road-92": Math.floor(Math.random() * 40 + 20), // 20-60
        "robo-dice": Math.floor(Math.random() * 15 + 5), // 5-20
        "plinko-aztec-v2": Math.random() < 0.2 ? Math.floor(Math.random() * 3) : 0,
        "chicken-road-two-4ravip": Math.random() < 0.3 ? Math.floor(Math.random() * 5 + 1) : 0,
        "plinko-v2": Math.random() < 0.4 ? Math.floor(Math.random() * 3 + 1) : 0,
        "chicken-road-two-social": Math.random() < 0.3 ? Math.floor(Math.random() * 3 + 1) : 0,
        "diver-fast": Math.random() < 0.3 ? Math.floor(Math.random() * 3 + 1) : 0,
        "penalty-unlimited-social": 0,
        "twist-social": 0,
        "chicken-road-97-social": 0,
        "diver-boomerang": 0,
        "rabbit-road": 0,
        "wheel-social": 0,
        "platform-mines-social": 0,
        "chicken-road-two-v3": 0,
        "forest-fortune-v1-social": 0,
        "chicken-road-two-v2": 0
    };

    return {
        result: {
            total: total,
            gameMode: gameMode
        }
    };
}

function generateRandomLastWin() {
    // 随机选择男性或女性名字
    const isMale = Math.random() < 0.5;
    const firstNames = isMale ? southeastAsianNames.maleNames : southeastAsianNames.femaleNames;

    // 随机选择名字和姓氏
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const surname = southeastAsianNames.surnames[Math.floor(Math.random() * southeastAsianNames.surnames.length)];

    // 组合用户名 (有时只用名字，有时用全名)
    const useFullName = Math.random() < 0.7; // 70%概率使用全名
    const username = useFullName ? `${firstName} ${surname}` : firstName;

    // 随机选择国家代码
    const countryCode = southeastAsianCountries[Math.floor(Math.random() * southeastAsianCountries.length)];

    // 生成随机获胜金额 (1,000 - 50,000)
    const winAmount = (Math.random() * (50000 - 1000) + 1000).toFixed(2);

    return {
        username: username,
        avatar: null,
        countryCode: countryCode,
        winAmount: winAmount,
        currency: serverCurrency
    };
}

// 游戏配置数据
const gameConfig = {
    coefficients: {
        EASY: ["1.01", "1.03", "1.06", "1.10", "1.15", "1.19", "1.24", "1.30", "1.35", "1.42", "1.48", "1.56", "1.65", "1.75", "1.85", "1.98", "2.12", "2.28", "2.47", "2.70", "2.96", "3.28", "3.70", "4.11", "4.64", "5.39", "6.50", "8.36", "12.08", "23.24"],
        MEDIUM: ["1.08", "1.21", "1.37", "1.56", "1.78", "2.05", "2.37", "2.77", "3.24", "3.85", "4.62", "5.61", "6.91", "8.64", "10.99", "14.29", "18.96", "26.07", "37.24", "53.82", "82.36", "137.59", "265.35", "638.82", "2457.00"],
        HARD: ["1.18", "1.46", "1.83", "2.31", "2.95", "3.82", "5.02", "6.66", "9.04", "12.52", "17.74", "25.80", "38.71", "60.21", "97.34", "166.87", "305.94", "595.86", "1283.03", "3267.64", "10898.54", "62162.09"],
        DAREDEVIL: ["1.44", "2.21", "3.45", "5.53", "9.09", "15.30", "26.78", "48.70", "92.54", "185.08", "391.25", "894.28", "2235.72", "6096.15", "18960.33", "72432.75", "379632.82", "3608855.25"]
    },
    // 难度设置 - 定义每个难度的马路线数和基础碰撞概率
    difficultySettings: {
        EASY: {
            totalLines: 30,
            baseCrashChance: 0.02,     // 基础碰撞概率 2%
            maxCrashChance: 0.15,      // 最大碰撞概率 15%
            increaseRate: 0.004        // 每步增加 0.4%
        },
        MEDIUM: {
            totalLines: 25,
            baseCrashChance: 0.03,     // 基础碰撞概率 3%
            maxCrashChance: 0.25,      // 最大碰撞概率 25%
            increaseRate: 0.008        // 每步增加 0.8%
        },
        HARD: {
            totalLines: 22,
            baseCrashChance: 0.05,     // 基础碰撞概率 5%
            maxCrashChance: 0.35,      // 最大碰撞概率 35%
            increaseRate: 0.012        // 每步增加 1.2%
        },
        DAREDEVIL: {
            totalLines: 18,
            baseCrashChance: 0.08,     // 基础碰撞概率 8%
            maxCrashChance: 0.45,      // 最大碰撞概率 45%
            increaseRate: 0.018        // 每步增加 1.8%
        }
    },
    lastWin: {
        username: 'Candy Do',
        avatar: null,
        countryCode: 'US',
        winAmount: '24157.48',
        currency: serverCurrency
    }
};

// ============ 游戏核心算法类 ============
class ChickenRoadGame {
    constructor(userId, betAmount, difficulty, currency = null) {
        this.userId = userId;
        this.betAmount = parseFloat(betAmount);
        this.difficulty = difficulty;
        this.currency = currency || serverCurrency;
        this.currentLine = -1;  // 下注后初始状态，匹配原版逻辑
        this.isFinished = false;
        this.isWin = false;
        this.crashLine = null;
        this.sessionId = `game_${userId}_${Date.now()}`;
        this.startTime = Date.now();

        // 获取难度配置
        this.difficultyConfig = gameConfig.difficultySettings[difficulty];
        this.coefficients = gameConfig.coefficients[difficulty];

        if (!this.difficultyConfig || !this.coefficients) {
            throw new Error(`Invalid difficulty: ${difficulty}`);
        }

        // 预先计算碰撞点（使用可证明公平算法）
        this.generateCrashPoint();

        console.log(`🎮 创建新游戏会话: ${this.sessionId}`);
        console.log(`💰 下注金额: ${this.betAmount} ${this.currency}`);
        console.log(`🎯 难度: ${this.difficulty}`);
        console.log(`💥 预设碰撞点: ${this.crashLine}`);
    }

    // 生成碰撞点（可证明公平算法）
    generateCrashPoint() {
        // 使用伪随机数生成器，结合时间戳和用户ID确保唯一性
        const seed = this.startTime + this.userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const random = this.seededRandom(seed);

        // 基于难度和随机数计算碰撞点
        const { totalLines, baseCrashChance, increaseRate } = this.difficultyConfig;

        // 使用指数分布来模拟真实的碰撞概率
        for (let line = 1; line <= totalLines; line++) {
            const crashChance = Math.min(
                baseCrashChance + (line - 1) * increaseRate,
                this.difficultyConfig.maxCrashChance
            );

            if (random() < crashChance) {
                this.crashLine = line;
                return;
            }
        }

        // 如果没有碰撞，设置为最大线数+1（玩家可以走完全程）
        this.crashLine = totalLines + 1;
    }

    // 种子随机数生成器（确保可重现）
    seededRandom(seed) {
        let current = seed;
        return function () {
            current = (current * 9301 + 49297) % 233280;
            return current / 233280;
        };
    }

    // 执行一步移动
    step() {
        if (this.isFinished) {
            throw new Error('Game is already finished');
        }

        this.currentLine++;

        // 检查是否撞车
        if (this.currentLine >= this.crashLine) {
            this.isFinished = true;
            this.isWin = false;
            console.log(`💥 玩家 ${this.userId} 在第 ${this.currentLine} 线撞车！`);
            return this.getGameState();
        }

        // 检查是否超出最大线数
        if (this.currentLine >= this.difficultyConfig.totalLines) {
            this.isFinished = true;
            this.isWin = true;
            console.log(`🎉 玩家 ${this.userId} 成功通过所有 ${this.currentLine} 线！`);
            return this.getGameState();
        }

        console.log(`🚶 玩家 ${this.userId} 前进到第 ${this.currentLine} 线`);
        return this.getGameState();
    }

    // 提现（主动结束游戏）
    withdraw() {
        if (this.isFinished) {
            throw new Error('Game is already finished');
        }

        if (this.currentLine < 0) {
            throw new Error('Cannot withdraw before making any moves');
        }

        this.isFinished = true;
        this.isWin = true;

        console.log(`💰 玩家 ${this.userId} 在第 ${this.currentLine} 线主动提现`);
        return this.getGameState();
    }

    // 获取当前游戏状态
    getGameState() {
        const coeff = this.getCurrentCoefficient();
        // 在游戏进行中，winAmount表示当前可提现金额（下注金额 × 当前系数）
        // 游戏结束时，winAmount表示实际获得的金额（获胜时为计算值，失败时为0）
        let winAmount;
        if (this.isFinished) {
            // 游戏已结束：获胜时给奖金，失败时为0
            winAmount = this.isWin ? (this.betAmount * coeff).toFixed(2) : "0.00";
        } else {
            // 游戏进行中：显示当前可提现金额
            winAmount = (this.betAmount * coeff).toFixed(2);
        }

        return {
            value: this.isFinished ? "init" : "game",  // 前端状态标识：游戏中为"game"，结束后为"init"
            sessionId: this.sessionId,
            isFinished: this.isFinished,
            isWin: this.isWin,
            currency: this.currency,
            betAmount: this.betAmount.toFixed(2),
            coeff: coeff.toFixed(2),
            winAmount: winAmount,
            difficulty: this.difficulty,
            lineNumber: this.currentLine,
            totalLines: this.difficultyConfig.totalLines,
            crashLine: this.isFinished ? this.crashLine : null,
            nextCrashChance: this.getNextCrashChance()
        };
    }

    // 获取当前系数
    getCurrentCoefficient() {
        if (this.currentLine < 0) return 1.0;  // 游戏开始前，系数为1.0

        // currentLine=0时使用coefficients[0]，currentLine=1时使用coefficients[1]，以此类推
        const index = Math.min(this.currentLine, this.coefficients.length - 1);
        return parseFloat(this.coefficients[index]);
    }

    // 获取下一步的碰撞概率（用于前端显示）
    getNextCrashChance() {
        if (this.isFinished) return 0;

        const nextLine = this.currentLine + 1;
        const { baseCrashChance, increaseRate, maxCrashChance } = this.difficultyConfig;

        return Math.min(
            baseCrashChance + (nextLine - 1) * increaseRate,
            maxCrashChance
        );
    }

    // 获取游戏统计信息
    getGameStats() {
        return {
            sessionId: this.sessionId,
            duration: Date.now() - this.startTime,
            totalSteps: this.currentLine,
            finalCoefficient: this.getCurrentCoefficient(),
            crashLine: this.crashLine,
            winAmount: this.isWin ? (this.betAmount * this.getCurrentCoefficient()) : 0
        };
    }
}

// 用户数据存储
const users = new Map();
const gameSessions = new Map(); // 存储活跃游戏会话 userId -> ChickenRoadGame

// 在线人数数据
let currentOnlineCount = generateRandomOnlineCount();

// 每30秒更新在线人数
setInterval(() => {
    currentOnlineCount = generateRandomOnlineCount();
    console.log(`🔄 更新在线人数: Total ${currentOnlineCount.result.total}, chicken-road-two: ${currentOnlineCount.result.gameMode['chicken-road-two']}`);
}, 30000);

// 货币汇率数据
const currencies = {
    "ADA": 1.2392174143753434, "AED": 3.6725, "AFN": 70, "ALL": 85.295, "AMD": 383.82, "ANG": 1.8022999999999998, "AOA": 918.65, "ARS": 1371.4821, "AUD": 1.5559, "AWG": 1.79, "AZN": 1.7, "BAM": 1.6806518215000001, "BBD": 2.0181999999999998, "BCH": 0.0017045540639090576, "BDT": 122.24999999999999, "BGN": 1.712, "BHD": 0.377, "BIF": 2981, "BMD": 1, "BNB": 0.0012364616933494387, "BND": 1.2974999999999999, "BOB": 6.907100000000001, "BRL": 5.6015, "BSD": 0.9997, "BTC": 0.000008564869954115922, "BTN": 87.6436791094, "BUSD": 0.9996936638705801, "BWP": 13.6553, "BYN": 3.2712, "BZD": 2.0078, "CAD": 1.3858, "CDF": 2878.2413366121, "CHF": 0.8140000000000001, "CLF": 0.0247045011, "CLP": 972.65, "CNY": 7.2005, "COP": 4186.71, "CRC": 505.29, "CSC": 9261.945282267225, "CUP": 23.990199999999998, "CVE": 94.75541144009999, "CZK": 21.5136, "DASH": 0.04338819898511679, "DJF": 178.08, "DKK": 6.5351, "DOGE": 4.242435504162127, "DOP": 61, "DZD": 130.923, "EGP": 48.57, "EOS": 1.2787330681036353, "ERN": 15, "ETB": 138.20000000000002, "ETC": 0.043012706908072615, "ETH": 0.00023978011431344083, "EUR": 0.8755000000000001, "FJD": 2.2723999999999998, "FKP": 0.7434563382, "GBP": 0.7571, "GC": 1, "GEL": 2.7035, "GHS": 10.5, "GIP": 0.7434563382, "GMD": 72.815, "GMS": 1, "GNF": 8674.5, "GTQ": 7.675, "GYD": 209.07067413080003, "HKD": 7.849799999999999, "HNL": 26.2787, "HRK": 6.4744232111999995, "HTG": 131.16899999999998, "HUF": 350.19, "IDR": 16443.4, "ILS": 3.3960999999999997, "INR": 87.503, "IQD": 1310, "IRR": 42112.5, "ISK": 124.46999999999998, "JMD": 159.94400000000002, "JOD": 0.709, "JPY": 150.81, "KES": 129.2, "KGS": 87.45, "KHR": 4015, "KMF": 431.5, "KPW": 900.0000293024999, "KRW": 1392.51, "KWD": 0.30610000000000004, "KYD": 0.8200054467, "KZT": 540.8199999999999, "LAK": 21580, "LBP": 89550, "LKR": 302.25, "LRD": 200.5010707152, "LSL": 18.2179, "LTC": 0.007988960675824544, "LYD": 5.415, "MAD": 9.154300000000001, "MDL": 17.08, "MGA": 4430, "MKD": 52.885000000000005, "MMK": 3247.961, "MNT": 3590, "MOP": 8.089, "MRU": 39.868258263499996, "MUR": 46.65, "MVR": 15.459999999999999, "MWK": 1733.67, "MXN": 18.869, "MYR": 4.265, "MZN": 63.910000000000004, "NAD": 18.2179, "NGN": 1532.39, "NIO": 36.75, "NOK": 10.3276, "NPR": 140.07, "NZD": 1.6986, "OMR": 0.385, "PAB": 1.0009, "PEN": 3.569, "PGK": 4.1303, "PHP": 58.27, "PKR": 283.25, "PLN": 3.7442, "PYG": 7486.400000000001, "QAR": 3.6408, "R$": 476.1904761904762, "RON": 4.440300000000001, "RSD": 102.56500000000001, "RUB": 79.87530000000001, "RWF": 1440, "SAR": 3.7513, "SBD": 8.4997824284, "SC": 1, "SCR": 14.1448, "SDG": 600.5, "SEK": 9.7896, "SGD": 1.2979, "SHIB": 73964.49704142012, "SHP": 0.7434563382, "SLE": 22.7050363806, "SOL": 0.00553958304709419, "SOS": 571.5, "SRD": 37.0609660498, "SSP": 130.26, "SVC": 8.7464, "SYP": 13005, "SZL": 18.01, "THB": 32.752, "TND": 2.88, "TON": 0.2968838466985716, "TRX": 2.964268646450315, "TRY": 40.6684, "TWD": 29.918000000000003, "TZS": 2570, "UAH": 41.6966, "uBTC": 8.56486995411592, "UGX": 3583.3, "PHP": 1, "USDC": 1.0002630591819341, "USDT": 1, "UYU": 40.0886, "UZS": 12605, "VEF": 13089180.84445514, "VES": 123.7216, "VND": 26199, "XAF": 573.151, "XLM": 2.2041169686964475, "XMR": 0.008457936691358008, "XRP": 0.30097067768794, "ZAR": 18.2178, "ZEC": 0.025361840980307002, "ZMW": 23.2009282325, "ZWL": 26.852999999999998
};

// 用户认证中间件
const authenticateSocket = (socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.Authorization;
    if (!token) {
        return next(new Error('Authentication required'));
    }

    try {
        // 模拟JWT验证（实际应用中应该用真实的JWT验证）
        const decoded = verifyJWT(token);

        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Invalid token: ' + err.message));
    }
};

// 应用认证中间件
io.use(authenticateSocket);

// 处理连接
io.on('connection', (socket) => {
    console.log(`🔗 用户连接: ${socket.user.nickname} (${socket.id})`);

    // 更新用户数据（可能在认证时已创建）
    const userId = socket.user.userId;
    if (!users.has(userId)) {
        // 如果认证时没有创建，现在创建
        users.set(userId, {
            userId: userId,
            nickname: socket.user.nickname,
            balance: parseFloat(socket.user.balance),
            currency: socket.user.currency || serverCurrency,
            socketId: socket.id,
            gameAvatar: socket.user.gameAvatar,
            isAuthenticated: false
        });
        console.log(`👤 Socket连接时创建用户数据: ${socket.user.nickname}`);
    } else {
        console.log(`👤 用户已存在，更新Socket连接: ${socket.user.nickname}`);
    }

    const user = users.get(userId);
    user.socketId = socket.id;
    user.isAuthenticated = true;  // 标记为已通过Socket认证
    user.currency = socket.user.currency || serverCurrency;
    // 发送初始数据
    setTimeout(() => {
        // 发送余额变化事件
        console.log(`📤 服务器发送 onBalanceChange:`, { currency: user.currency, balance: user.balance.toFixed(3) });
        socket.emit('onBalanceChange', {
            currency: user.currency,
            balance: user.balance.toFixed(3)
        });

        // 发送下注范围
        console.log(`📤 服务器发送 betsRanges`);
        const currencyConfig = getCurrentCurrencyConfig();
        const betsRanges = {};
        betsRanges[user.currency] = currencyConfig.betRanges;
        socket.emit('betsRanges', betsRanges);

        // 发送下注配置
        console.log(`📤 服务器发送 betsConfig`);
        const betsConfig = {};
        betsConfig[user.currency] = {
            betPresets: currencyConfig.betPresets,
            minBetAmount: currencyConfig.minBetAmount,
            maxBetAmount: currencyConfig.maxBetAmount,
            maxWinAmount: currencyConfig.maxWinAmount,
            defaultBetAmount: currencyConfig.defaultBetAmount,
            decimalPlaces: null
        };
        socket.emit('betsConfig', betsConfig);

        // 发送用户数据
        console.log(`📤 服务器发送 myData:`, { userId: user.userId, nickname: user.nickname, gameAvatar: user.gameAvatar });
        socket.emit('myData', {
            userId: user.userId,
            nickname: user.nickname,
            gameAvatar: user.gameAvatar
        });

        // 发送货币汇率
        console.log(`📤 服务器发送 currencies`);
        socket.emit('currencies', currencies);



    }, 100);

    // 设置每10秒发送一次随机lastWin数据
    const lastWinInterval = setInterval(() => {
        const randomLastWin = generateRandomLastWin();
        console.log(`🎰 定时发送随机 gameService-last-win:`, randomLastWin);
        socket.emit('gameService-last-win', randomLastWin);
    }, 10000); // 每10秒发送一次

    // 处理游戏服务请求
    socket.on('gameService', (data, callback) => {
        console.log(`🎮 收到gameService请求:`);
        console.log(`🎮 原始数据:`, JSON.stringify(data, null, 2));
        console.log(`🎮 数据类型:`, typeof data);
        console.log(`🎮 是否为数组:`, Array.isArray(data));
        console.log(`🎮 回调函数:`, typeof callback);

        // 处理数组格式的数据（Socket.IO常见格式）
        let requestData = data;
        if (Array.isArray(data) && data.length > 0) {
            requestData = data[0];
            console.log(`🎮 提取的请求数据:`, JSON.stringify(requestData, null, 2));
        }

        if (requestData && typeof requestData === 'object') {
            console.log(`🎮 请求动作:`, requestData.action);



            switch (requestData.action) {
                case 'get-game-config':
                    console.log(`📋 处理get-game-config请求`);
                    gameConfig.lastWin = generateRandomLastWin();
                    console.log(`📤 发送430响应 - 游戏配置:`, JSON.stringify(gameConfig, null, 2));

                    // 移除主动emit，只使用回调
                    // console.log(`🧪 尝试方式1: socket.emit('430', [gameConfig])`);
                    // socket.emit('430', [gameConfig]);

                    // console.log(`🧪 尝试方式2: socket.emit(430, [gameConfig])`);
                    // socket.emit(430, [gameConfig]);

                    // console.log(`🧪 尝试方式3: socket.send()`);
                    // socket.send(['430', [gameConfig]]);

                    break;

                case 'get-game-state':
                    console.log(`🎯 处理get-game-state请求`);
                    // gameState现在在回调函数中定义和处理
                    console.log(`📤 将通过回调发送431响应`);

                    break;

                case 'step':
                    console.log(`🚶 处理step请求:`, requestData.payload);
                    // step操作现在在回调函数中处理
                    console.log(`📤 将通过回调发送432响应`);

                    break;

                case 'withdraw':
                    console.log(`💸 处理withdraw请求 - 游戏结束结算`);
                    console.log(`📤 将通过回调发送433响应`);

                    break;

                case 'bet':
                    console.log(`💰 处理bet请求:`, requestData.payload);
                    // 处理下注逻辑（稍后实现）
                    break;

                default:
                    console.log(`❓ 未知请求动作:`, requestData.action);
                    // 发送默认游戏配置
                    console.log(`📤 发送默认430响应`);
                    // socket.emit(430, [gameConfig]);
                    break;
            }
        } else {
            console.log(`❌ 无效的请求数据格式`);
            console.log(`📤 发送默认430响应`);
            // socket.emit(430, [gameConfig]);
        }

        // 如果有回调函数，调用它
        if (typeof callback === 'function') {
            console.log(`📞 调用回调函数`);

            // 根据请求动作返回对应数据
            if (requestData && requestData.action === 'get-game-config') {
                console.log(`📞 回调返回游戏配置数据`);
                callback(gameConfig);
            } else if (requestData && requestData.action === 'get-game-state') {
                // 获取当前游戏状态
                const currentGame = gameSessions.get(userId);

                if (currentGame) {
                    console.log(`📞 回调返回现有游戏状态数据`);
                    callback(currentGame.getGameState());
                } else {

                    // return {
                    //     value: this.isFinished ? "init" : "game",  // 前端状态标识：游戏中为"game"，结束后为"init"
                    //     sessionId: this.sessionId,
                    //     isFinished: this.isFinished,
                    //     isWin: this.isWin,
                    //     currency: this.currency,
                    //     betAmount: this.betAmount.toFixed(2),
                    //     coeff: coeff.toFixed(2),
                    //     winAmount: winAmount,
                    //     difficulty: this.difficulty,
                    //     lineNumber: this.currentLine,
                    //     totalLines: this.difficultyConfig.totalLines,
                    //     crashLine: this.isFinished ? this.crashLine : null,
                    //     nextCrashChance: this.getNextCrashChance()
                    // };
                    // 没有活跃游戏，返回null让前端显示PLAY按钮
                    console.log(`📞 回调返回null，前端显示PLAY按钮`);
                    callback(null);
                }
            } else if (requestData && requestData.action === 'step') {
                // 执行移动步骤
                const currentGame = gameSessions.get(userId);

                if (!currentGame) {
                    console.log(`❌ 没有找到活跃的游戏会话，用户: ${userId}`);
                    console.log(`📊 当前活跃会话数: ${gameSessions.size}`);

                    // 返回错误状态，而不是抛出异常
                    callback({
                        value: "init",
                        sessionId: null,
                        isFinished: true,
                        isWin: false,
                        currency: user.currency,
                        betAmount: "0.00",
                        coeff: "1.00",
                        winAmount: "0.00",
                        difficulty: "EASY",
                        lineNumber: 0,
                        totalLines: 30,
                        crashLine: null,
                        nextCrashChance: 0.02,
                        error: 'No active game session found'
                    });
                    return;
                }

                try {
                    const stepResult = currentGame.step();
                    console.log(`📞 回调返回step状态数据 - lineNumber: ${stepResult.lineNumber}, coeff: ${stepResult.coeff}, isFinished: ${stepResult.isFinished}`);

                    // 如果游戏结束，清理游戏会话（余额已在下注时扣除，这里不需要再次扣除）
                    if (stepResult.isFinished) {
                        console.log(`🎮 游戏结束 - 玩家: ${userId}, 结果: ${stepResult.isWin ? '获胜' : '失败'}`);

                        // 清理游戏会话
                        gameSessions.delete(userId);
                    }

                    callback(stepResult);
                } catch (error) {
                    console.error(`❌ Step执行错误:`, error);
                    callback({
                        value: "init",
                        sessionId: null,
                        isFinished: true,
                        isWin: false,
                        currency: user.currency,
                        betAmount: "0.00",
                        coeff: "1.00",
                        winAmount: "0.00",
                        difficulty: "EASY",
                        lineNumber: 0,
                        totalLines: 30,
                        crashLine: null,
                        nextCrashChance: 0.02,
                        error: error.message
                    });
                }
            } else if (requestData && requestData.action === 'withdraw') {
                // 提现操作 - 游戏结束结算
                const currentGame = gameSessions.get(userId);

                if (!currentGame) {
                    console.log(`❌ 没有找到活跃的游戏会话进行提现，用户: ${userId}`);
                    console.log(`📊 当前活跃会话数: ${gameSessions.size}`);

                    // 返回错误状态，而不是抛出异常
                    callback({
                        value: "init",
                        sessionId: null,
                        isFinished: true,
                        isWin: false,
                        currency: user.currency,
                        betAmount: "0.00",
                        coeff: "1.00",
                        winAmount: "0.00",
                        difficulty: "EASY",
                        lineNumber: 0,
                        totalLines: 30,
                        crashLine: null,
                        nextCrashChance: 0.02,
                        error: 'No active game session found for withdrawal'
                    });
                    return;
                }

                try {
                    const withdrawResult = currentGame.withdraw();
                    console.log(`📞 回调返回withdraw结算数据 - 游戏结束, lineNumber: ${withdrawResult.lineNumber}, coeff: ${withdrawResult.coeff}, winAmount: ${withdrawResult.winAmount}`);

                    // 更新余额：当前余额 + 奖金（下注金额已在bet时扣除）
                    const betAmountNum = currentGame.betAmount;
                    const winAmountNum = parseFloat(withdrawResult.winAmount);
                    user.balance = user.balance + winAmountNum;

                    console.log(`💰 提现成功: 原余额 ${(user.balance - winAmountNum).toFixed(2)} + 奖金 ${winAmountNum} = 新余额 ${user.balance.toFixed(2)}`);

                    // 发送余额变化通知
                    setTimeout(() => {
                        socket.emit('onBalanceChange', {
                            currency: user.currency,
                            balance: user.balance.toFixed(2)
                        });
                    }, 100);

                    // 清理游戏会话
                    gameSessions.delete(userId);

                    callback(withdrawResult);
                } catch (error) {
                    console.error(`❌ Withdraw执行错误:`, error);
                    callback({
                        value: "init",
                        sessionId: null,
                        isFinished: true,
                        isWin: false,
                        currency: user.currency,
                        betAmount: "0.00",
                        coeff: "1.00",
                        winAmount: "0.00",
                        difficulty: "EASY",
                        lineNumber: 0,
                        totalLines: 30,
                        crashLine: null,
                        nextCrashChance: 0.02,
                        error: error.message
                    });
                }
            } else if (requestData && requestData.action === 'bet') {
                // 下注操作 - 游戏开始
                const payload = requestData.payload || {};
                const betAmount = parseFloat(payload.betAmount) || 0.6;
                const difficulty = payload.difficulty || "EASY";
                const currency = payload.currency || user.currency;

                // 检查余额是否足够
                if (user.balance < betAmount) {
                    console.log(`❌ 余额不足: 需要 ${betAmount}, 当前 ${user.balance}`);
                    callback({
                        value: "init",
                        sessionId: null,
                        isFinished: false,
                        isWin: false,
                        currency: user.currency,
                        betAmount: "0.00",
                        coeff: "1.00",
                        winAmount: "0.00",
                        difficulty: difficulty,
                        lineNumber: -1,
                        totalLines: gameConfig.difficultySettings[difficulty]?.totalLines || 30,
                        crashLine: null,
                        nextCrashChance: gameConfig.difficultySettings[difficulty]?.baseCrashChance || 0.02,
                        error: 'Insufficient balance'
                    });
                    return;
                }

                try {
                    // 清理之前的游戏会话
                    if (gameSessions.has(userId)) {
                        gameSessions.delete(userId);
                    }

                    // 立即扣除下注金额（下注时就扣除，而不是失败时才扣除）
                    user.balance = Math.max(0, user.balance - betAmount);
                    console.log(`💰 下注成功，扣除金额: ${betAmount}, 剩余余额: ${user.balance.toFixed(2)}`);

                    // 发送余额变化通知
                    setTimeout(() => {
                        socket.emit('onBalanceChange', {
                            currency: user.currency,
                            balance: user.balance.toFixed(2)
                        });
                    }, 100);

                    // 创建新的游戏会话
                    const newGame = new ChickenRoadGame(userId, betAmount, difficulty, currency);
                    gameSessions.set(userId, newGame);

                    const betState = newGame.getGameState();
                    console.log(`📞 回调返回bet初始状态 - betAmount: ${betAmount}, difficulty: ${difficulty}, sessionId: ${newGame.sessionId}`);
                    callback(betState);
                } catch (error) {
                    console.error(`❌ 创建游戏会话错误:`, error);
                    callback({
                        value: "init",
                        sessionId: null,
                        isFinished: false,
                        isWin: false,
                        currency: user.currency,
                        betAmount: "0.00",
                        coeff: "1.00",
                        winAmount: "0.00",
                        difficulty: difficulty,
                        lineNumber: -1,
                        totalLines: gameConfig.difficultySettings[difficulty]?.totalLines || 30,
                        crashLine: null,
                        nextCrashChance: gameConfig.difficultySettings[difficulty]?.baseCrashChance || 0.02,
                        error: error.message
                    });
                }
            } else {
                // console.log(`📞 回调返回默认游戏配置`);
                // callback(gameConfig);
            }
        }
    });

    // 处理下注
    socket.on('placeBet', (betData) => {
        console.log(`💰 用户下注:`, betData);
        const { betAmount, difficulty } = betData;

        if (user.balance >= betAmount) {
            user.balance -= betAmount;

            // 模拟游戏结果
            const isWin = Math.random() > 0.5;
            let winAmount = 0;
            let coeff = "1.00";

            if (isWin && gameConfig.coefficients[difficulty]) {
                const coeffArray = gameConfig.coefficients[difficulty];
                const randomCoeff = coeffArray[Math.floor(Math.random() * coeffArray.length)];
                coeff = randomCoeff;
                winAmount = betAmount * parseFloat(randomCoeff);
                user.balance += winAmount;
            }

            // 发送游戏结果
            socket.emit('gameResult', {
                isWin,
                betAmount,
                winAmount: winAmount.toFixed(3),
                coeff,
                difficulty,
                newBalance: user.balance.toFixed(3)
            });

            // 发送余额更新
            socket.emit('onBalanceChange', {
                currency: user.currency,
                balance: user.balance.toFixed(3)
            });
        } else {
            socket.emit('error', { message: '余额不足' });
        }
    });

    // // 定期发送余额更新（模拟实时变化）
    // const balanceInterval = setInterval(() => {

    //     user.balance = Math.max(0, user.balance); // 确保余额不为负数

    //     socket.emit('onBalanceChange', {
    //         currency: user.currency,
    //         balance: user.balance.toFixed(3)
    //     });

    //     console.log(`📤 更新余额: ${user.nickname} - ${user.balance.toFixed(3)} ${user.currency}`);
    // }, 5000);

    // 注意：获胜信息已经通过上面的 lastWinInterval 定时器发送，无需重复

    // 处理断开连接
    socket.on('disconnect', (reason) => {
        console.log(`🔌 用户断开连接: ${socket.user.nickname}, 原因: ${reason}`);

        // 清理用户的游戏会话
        if (gameSessions.has(userId)) {
            const gameSession = gameSessions.get(userId);
            console.log(`🎮 清理游戏会话: ${gameSession.sessionId}`);
            gameSessions.delete(userId);
        }

        // 清理定时器
        clearInterval(lastWinInterval);
        // clearInterval(balanceInterval);
        // clearInterval(winInterval);
    });

    // 错误处理
    socket.on('error', (error) => {
        console.error('❌ Socket 错误:', error);
    });
});

// API路由处理 (在静态文件之前)
app.all('/api/*', (req, res, next) => {
    const apiPath = req.path;
    console.log(`🔥 API路由匹配: ${req.method} ${apiPath}`);

    // 对于需要动态处理的API路径，直接继续到下一个中间件
    if (apiPath === '/api/auth' || apiPath === '/api/online-counter/v1/data' || apiPath === '/api/modes/game') {
        return next();
    }

    // 尝试找到对应的HTML文件
    const htmlFile = path.join(__dirname, apiPath + '.html');

    if (fs.existsSync(htmlFile)) {
        const content = fs.readFileSync(htmlFile, 'utf8');
        try {
            const jsonData = JSON.parse(content);
            res.json(jsonData);
            console.log(`✅ 文件响应成功: ${htmlFile}`);
        } catch (e) {
            res.send(content);
        }
    } else {
        // 默认API响应
        const defaultResponse = {
            status: 0,
            maxAge: 0,
            model: {
                message: "本地API响应",
                path: apiPath,
                method: req.method,
                timestamp: Date.now()
            }
        };
        res.json(defaultResponse);
        console.log(`⚠️  默认响应: ${apiPath}`);
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 在线人数API端点
app.get('/api/online-counter/v1/data', (req, res) => {
    console.log(`📊 在线人数请求 - Total: ${currentOnlineCount.result.total}, chicken-road-two: ${currentOnlineCount.result.gameMode['chicken-road-two']}`);
    res.json(currentOnlineCount);
});

// 游戏模式API端点 - 动态处理URL参数
app.get('/api/modes/game', (req, res) => {
    const { gameMode, operatorId, authToken, currency, lang, theme, gameCustomizationId, lobbyUrl } = req.query;

    console.log(`🎮 游戏模式请求:`);
    console.log(`  gameMode: ${gameMode}`);
    console.log(`  operatorId: ${operatorId}`);
    console.log(`  authToken: ${authToken}`);
    console.log(`  currency: ${currency}`);
    console.log(`  lang: ${lang}`);
    console.log(`  theme: ${theme}`);
    console.log(`  gameCustomizationId: ${gameCustomizationId}`);
    console.log(`  lobbyUrl: ${lobbyUrl}`);

    // 读取基础HTML模板
    const htmlFile = path.join(__dirname, 'api/modes/game.html');
    let content = fs.readFileSync(htmlFile, 'utf8');

    // 根据参数动态修改内容
    // 更新VITE_API_ENDPOINT以确保正确的API调用
    // 动态检测协议，支持HTTPS
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('host') || req.get('x-forwarded-host') || 'chick.xoxbrwin.com';
    const apiEndpoint = `${protocol}://${host}`;

    content = content.replace(
        // 'VITE_API_ENDPOINT: "https://chick.xoxbrwin.com"',
        // `VITE_API_ENDPOINT: "${apiEndpoint}"`
        'VITE_API_ENDPOINT: "http://localhost:8001"',
        `VITE_API_ENDPOINT: "http://localhost:8001"`
    );

    // 添加游戏参数到window.env
    const gameParams = {
        gameMode: gameMode || 'chicken-road-two',
        operatorId: operatorId || '63565b4f-abbe-4850-9dac-9d50e5dc4283',
        authToken: authToken || 'e073e0e40c704b5b9544cc8b5e1c61ef_inout',
        currency: currency || serverCurrency,
        lang: lang || 'en',
        theme: theme || '',
        gameCustomizationId: gameCustomizationId || '',
        lobbyUrl: lobbyUrl || ''
    };

    // 在window.env中添加游戏参数
    // 直接在RTP_VALUE后添加游戏参数
    content = content.replace(
        `RTP_VALUE: '0.955',`,
        `RTP_VALUE: '0.955',
        GAME_MODE: "${gameParams.gameMode}",
        OPERATOR_ID: "${gameParams.operatorId}",
        AUTH_TOKEN: "${gameParams.authToken}",
        CURRENCY: "${gameParams.currency}",
        LANG: "${gameParams.lang}",
        THEME: "${gameParams.theme}",
        GAME_CUSTOMIZATION_ID: "${gameParams.gameCustomizationId}",
        LOBBY_URL: "${gameParams.lobbyUrl}",`
    );

    // 重要：确保URL中的参数也被正确传递到前端
    // 前端JavaScript会通过URLSearchParams读取这些参数
    // 我们需要确保URL保持原始参数不变
    console.log(`🔧 前端将从URL参数读取: currency=${gameParams.currency}, lang=${gameParams.lang}`);

    // 设置正确的Content-Type
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.send(content);
    console.log(`✅ 游戏页面响应已发送 - currency: ${gameParams.currency}, lang: ${gameParams.lang}`);
});

// 认证API端点 - POST方法
app.post('/api/auth', (req, res) => {
    console.log(`🔐 认证请求 (POST) - User-Agent: ${req.get('User-Agent')}`);
    console.log(`🔐 认证请求 (POST) - Referer: ${req.get('Referer')}`);
    console.log(`🔐 认证请求 (POST) - Origin: ${req.get('Origin')}`);
    console.log(`📦 请求体:`, req.body);

    // 设置响应头，匹配真实 API
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Country-Code', 'TW'); // 匹配真实 API 的 country-code
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('ETag', 'W/"4b5-aD4UMihvLGLLICOeTVlQtJc/+PQ"'); // 模拟 ETag
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

    // 从请求体中获取用户信息（如果有的话）
    const { operator, auth_token, currency, game_mode } = req.body;

    // 设置服务器货币（如果前端传入了货币参数）
    if (currency) {
        setServerCurrency(currency);
    }

    // 生成用户数据
    const userData = {
        userId: "e073e0e40c704b5b9544cc8b5e1c61ef",
        nickname: "9K8708359465",
        balance: "21.295",
        currency: currency || serverCurrency
    };

    // 生成动态JWT token
    //const dynamicJWT = generateJWT(userData);
    const dynamicJWT = auth_token;
    // console.log("dynamicJWT:" + dynamicJWT)
    // 创建会话记录
    // const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    // activeSessions.set(sessionId, {
    //     userId: userData.userId,
    //     token: dynamicJWT,
    //     createdAt: Date.now(),
    //     gameMode: game_mode,
    //     operator: operator
    // });

    // // 初始化用户数据 - 提前为用户创建基础数据
    // if (!users.has(userData.userId)) {
    //     users.set(userData.userId, {
    //         userId: userData.userId,
    //         nickname: userData.nickname,
    //         balance: parseFloat(userData.balance),
    //         currency: userData.currency,
    //         socketId: null,
    //         gameAvatar: null,
    //         isAuthenticated: true
    //     });
    //     console.log(`👤 预创建用户数据: ${userData.nickname} (${userData.userId})`);
    // }

    // if (CONFIG.DEBUG_MODE) {
    //     console.log(`🎫 生成新的JWT token: ${dynamicJWT.substring(0, 50)}...`);
    //     console.log(`📊 活跃会话数: ${activeSessions.size}`);
    //     console.log(`🔗 会话ID: ${sessionId}`);
    //     console.log(`⚙️  一次性使用模式: ${CONFIG.JWT_ONE_TIME_USE ? '启用' : '禁用'}`);
    // }

    // 返回认证响应，每次生成新的JWT
    const authResponse = {
        "success": true,
        "result": dynamicJWT,
        "data": dynamicJWT,
        "gameConfig": null,
        "bonuses": [],
        "isLobbyEnabled": false,
        "isPromoCodeEnabled": false,
        "isSoundEnabled": false,
        "isMusicEnabled": false
    }

    // 使用 201 状态码匹配真实 API
    res.status(201).json(authResponse);

    console.log(`✅ 认证响应已发送 - 状态码: 201, Country-Code: TW`);
});


// JWT调试端点 - 用于检查token状态
app.post('/debug/jwt', (req, res) => {
    // 检查是否启用调试端点
    if (!CONFIG.ENABLE_DEBUG_ENDPOINTS) {
        return res.status(404).json({ error: 'Debug endpoints are disabled' });
    }

    const { token } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    try {
        // 解析JWT（不验证签名）
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }

        const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

        const now = Math.floor(Date.now() / 1000);
        const isExpired = payload.exp < now;
        const isUsed = CONFIG.JWT_ONE_TIME_USE && usedTokens.has(token);

        res.json({
            valid: !isExpired && !isUsed,
            used: isUsed,
            expired: isExpired,
            header: header,
            payload: payload,
            timeLeft: isExpired ? 0 : payload.exp - now,
            activeSessions: activeSessions.size,
            usedTokensCount: usedTokens.size,
            serverConfig: {
                oneTimeUse: CONFIG.JWT_ONE_TIME_USE,
                expireHours: CONFIG.JWT_EXPIRE_HOURS,
                debugMode: CONFIG.DEBUG_MODE
            }
        });

    } catch (error) {
        res.status(400).json({
            error: 'Invalid token format',
            details: error.message
        });
    }
});

// 游戏信息端点
app.get('/game-info', (req, res) => {
    res.json({
        gameMode: 'chicken-road-two',
        operatorId: '63565b4f-abbe-4850-9dac-9d50e5dc4283',
        connectedUsers: users.size,
        activeSessions: gameSessions.size,
        gameConfig: gameConfig
    });
});

// 货币配置测试端点
app.get('/test-currency', (req, res) => {
    if (!CONFIG.ENABLE_DEBUG_ENDPOINTS) {
        return res.status(404).json({ error: 'Debug endpoints are disabled' });
    }

    const { currency } = req.query;

    if (currency) {
        setServerCurrency(currency);
    }

    res.json({
        currentServerCurrency: serverCurrency,
        defaultCurrency: CONFIG.DEFAULT_CURRENCY,
        supportedCurrencies: Object.keys(currencyConfigs),
        currentConfig: getCurrentCurrencyConfig(),
        allConfigs: currencyConfigs
    });
});

// 货币配置设置端点
app.post('/set-currency', (req, res) => {
    if (!CONFIG.ENABLE_DEBUG_ENDPOINTS) {
        return res.status(404).json({ error: 'Debug endpoints are disabled' });
    }

    const { currency } = req.body;

    if (!currency) {
        return res.status(400).json({ error: 'Currency parameter is required' });
    }

    const success = setServerCurrency(currency);

    res.json({
        success: success,
        currentServerCurrency: serverCurrency,
        previousCurrency: success ? currency : serverCurrency,
        message: success ? `服务器货币已设置为: ${currency}` : `不支持的货币: ${currency}`
    });
});

// 游戏统计端点
app.get('/game-stats', (req, res) => {
    if (!CONFIG.ENABLE_DEBUG_ENDPOINTS) {
        return res.status(404).json({ error: 'Debug endpoints are disabled' });
    }

    const stats = {
        totalUsers: users.size,
        activeGames: gameSessions.size,
        currentServerCurrency: serverCurrency,
        gamesByDifficulty: {
            EASY: 0,
            MEDIUM: 0,
            HARD: 0,
            DAREDEVIL: 0
        },
        totalBalance: 0,
        activeSessions: []
    };

    // 统计用户余额
    for (const user of users.values()) {
        stats.totalBalance += user.balance;
    }

    // 统计游戏会话
    for (const [userId, game] of gameSessions.entries()) {
        stats.gamesByDifficulty[game.difficulty]++;
        stats.activeSessions.push({
            userId: userId,
            sessionId: game.sessionId,
            difficulty: game.difficulty,
            currentLine: game.currentLine,
            betAmount: game.betAmount,
            currency: game.currency,
            isFinished: game.isFinished,
            duration: Date.now() - game.startTime
        });
    }

    res.json(stats);
});

// 模拟游戏结果端点（用于测试）
app.post('/test-game', (req, res) => {
    if (!CONFIG.ENABLE_DEBUG_ENDPOINTS) {
        return res.status(404).json({ error: 'Debug endpoints are disabled' });
    }

    const { betAmount = 1, difficulty = 'EASY', steps = 5 } = req.body;

    try {
        // 创建测试游戏
        const testGame = new ChickenRoadGame('test_user_' + Date.now(), betAmount, difficulty);
        const results = [];

        // 模拟游戏步骤
        for (let i = 0; i < steps && !testGame.isFinished; i++) {
            const stepResult = testGame.step();
            results.push({
                step: i + 1,
                ...stepResult
            });
        }

        res.json({
            gameStats: testGame.getGameStats(),
            steps: results,
            finalState: testGame.getGameState()
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 静态文件服务 (在API路由之后)
app.use(express.static('.', {
    setHeaders: (res, path) => {
        // 为HTML文件设置正确的Content-Type
        if (path.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
    }
}));

// 错误处理
io.on('error', (error) => {
    console.error('❌ Socket.IO 服务器错误:', error);
});

const PORT = CONFIG.PORT;
httpServer.listen(PORT, () => {
    console.log(`鸡过马路游戏服务器启动成功! (已合并local功能)`);
    console.log(`服务器地址: http://localhost:${PORT}`);
    console.log(`WebSocket 连接地址: ws://localhost:${PORT}/io/`);
    console.log(`静态文件目录: ${__dirname}`);
    console.log(`API请求将被代理到本地文件`);
    console.log(`Web页面和API都在同一端口提供服务`);
    console.log(`所有请求将被详细记录到控制台`);
    console.log(`游戏模式: chicken-road-two`);
    console.log(`操作员ID: 63565b4f-abbe-4850-9dac-9d50e5dc4283`);
    console.log(`支持货币: ${Object.keys(currencyConfigs).join(', ')} (默认: ${CONFIG.DEFAULT_CURRENCY}, 当前: ${serverCurrency})`);

    // 显示配置信息
    console.log(`\n📋 当前配置:`);
    console.log(`   🔒 一次性使用模式: ${CONFIG.JWT_ONE_TIME_USE ? '启用' : '禁用'}`);
    console.log(`   ⏰ JWT过期时间: ${CONFIG.JWT_EXPIRE_HOURS}小时`);
    console.log(`   🧹 清理间隔: ${CONFIG.SESSION_CLEANUP_HOURS}小时`);
    console.log(`   🐛 调试模式: ${CONFIG.DEBUG_MODE ? '启用' : '禁用'}`);
    console.log(`   🔧 调试端点: ${CONFIG.ENABLE_DEBUG_ENDPOINTS ? '启用' : '禁用'}`);

    if (!CONFIG.JWT_ONE_TIME_USE) {
        console.log(`\n⚠️  注意: JWT可重复使用模式已启用，适合开发测试`);
    }

    // 定期清理过期的token和会话
    const cleanupInterval = CONFIG.SESSION_CLEANUP_HOURS * 3600000; // 转换为毫秒
    setInterval(() => {
        const now = Date.now();
        let cleanedTokens = 0;
        let cleanedSessions = 0;

        // 清理过期会话
        const sessionExpireTime = CONFIG.JWT_EXPIRE_HOURS * 3600000; // JWT过期时间对应的毫秒数
        for (const [sessionId, session] of activeSessions.entries()) {
            if (now - session.createdAt > sessionExpireTime) {
                activeSessions.delete(sessionId);
                cleanedSessions++;
            }
        }

        // 清理过期token（简单策略：当数量过多时清理）
        if (usedTokens.size > 1000) {
            usedTokens.clear();
            cleanedTokens = 1000;
        }

        if (CONFIG.DEBUG_MODE && (cleanedTokens > 0 || cleanedSessions > 0)) {
            console.log(`清理完成 - 清理了 ${cleanedTokens} 个token, ${cleanedSessions} 个会话`);
            console.log(`当前状态 - 活跃会话: ${activeSessions.size}, 已使用token: ${usedTokens.size}`);
        }
    }, cleanupInterval);
});