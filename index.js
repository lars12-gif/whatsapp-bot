const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const readline = require('readline');
const fs = require('fs');

// ============================================================
// ⚙️ الإعدادات
// ============================================================

const CONFIG = {
    // مدة نافذة الكشف
    DETECTION_WINDOW_MS: 5000,

    // عدد جهات الاتصال المطلوب لتفعيل الحماية
    REQUIRED_CONTACTS: 3,

    // ملفات البوت
    AUTH_FOLDER: './auth_info_baileys',
    ADMINS_FILE: './admins.json'
};

// ============================================================
// 👑 إعداد ملف المشرفين
// ============================================================

if (!fs.existsSync(CONFIG.ADMINS_FILE)) {
    fs.writeFileSync(CONFIG.ADMINS_FILE, '[]', 'utf8');
}

function getAdmins() {
    try {
        const data = fs.readFileSync(CONFIG.ADMINS_FILE, 'utf8');
        const admins = JSON.parse(data);

        return Array.isArray(admins) ? admins : [];
    } catch (error) {
        console.error('❌ خطأ في قراءة admins.json:', error.message);
        return [];
    }
}

function saveAdmins(admins) {
    fs.writeFileSync(
        CONFIG.ADMINS_FILE,
        JSON.stringify(admins, null, 2),
        'utf8'
    );
}

function addAdmin(number) {
    const cleanNumber = String(number)
        .replace(/[^0-9]/g, '');

    if (!cleanNumber) {
        return false;
    }

    const jid = `${cleanNumber}@s.whatsapp.net`;
    const admins = getAdmins();

    if (admins.includes(jid)) {
        return false;
    }

    admins.push(jid);
    saveAdmins(admins);

    return true;
}

// ============================================================
// 🛡️ نظام كشف جهات الاتصال
// ============================================================

// لكل شخص سجل مستقل.
// رسائل الأشخاص الآخرين لا تؤثر عليه.
const contactTracker = new Map();

/*
    شكل البيانات:

    contactTracker = {
        "رقم الشخص": {
            messages: [
                { key: رسالة1, timestamp: وقت1 },
                { key: رسالة2, timestamp: وقت2 }
            ]
        }
    }
*/

// استخراج جهة الاتصال من الرسالة
function getContactCount(messageContent) {
    if (!messageContent) {
        return 0;
    }

    // جهة اتصال واحدة
    if (messageContent.contactMessage) {
        return 1;
    }

    // عدة جهات اتصال
    if (messageContent.contactsArrayMessage) {
        const contacts =
            messageContent.contactsArrayMessage.contacts || [];

        return contacts.length;
    }

    return 0;
}

// تسجيل جهات الاتصال وحساب العدد خلال 5 ثوانٍ
function registerContactMessage(sender, msg, contactCount) {
    const now = Date.now();

    if (!contactTracker.has(sender)) {
        contactTracker.set(sender, {
            messages: []
        });
    }

    const userData = contactTracker.get(sender);

    // نحذف السجلات التي خرجت من نافذة الـ5 ثواني
    userData.messages = userData.messages.filter(
        item => now - item.timestamp <= CONFIG.DETECTION_WINDOW_MS
    );

    // إضافة الرسالة الحالية
    userData.messages.push({
        key: msg.key,
        timestamp: now,
        count: contactCount
    });

    // حساب مجموع جهات الاتصال خلال النافذة الزمنية
    const totalContacts = userData.messages.reduce(
        (total, item) => total + item.count,
        0
    );

    // تفعيل الحماية عند 3 أو أكثر
    if (totalContacts >= CONFIG.REQUIRED_CONTACTS) {
        return {
            triggered: true,
            messages: [...userData.messages]
        };
    }

    return {
        triggered: false,
        messages: []
    };
}

// تنظيف بيانات الشخص بعد انتهاء الحالة
function clearTracker(sender) {
    contactTracker.delete(sender);
}

// تنظيف تلقائي للسجلات القديمة
setInterval(() => {
    const now = Date.now();

    for (const [sender, data] of contactTracker.entries()) {
        data.messages = data.messages.filter(
            item => now - item.timestamp <= CONFIG.DETECTION_WINDOW_MS
        );

        if (data.messages.length === 0) {
            contactTracker.delete(sender);
        }
    }
}, 1000);

// ============================================================
// 📢 رسالة مكافحة المبند
// ============================================================

const SECURITY_MESSAGE = `
🚨 𝐒𝐄𝐂𝐔𝐑𝐈𝐓𝐘 𝐀𝐋𝐄𝐑𝐓 🚨

⚔️ تـمـت مـكـافـحـة الـمـبـنـد الـخـايـس بنجاح.

🗑️ الرسائل: تمت الإزالة
🔒 الشات: تم الإغلاق
🛡️ الحماية: مفعّلة
🚪 الإجراء: طرد العضو

😂 بنعالي أصلخك، لا تعيدها.

🍥 مملكة وانو
🥷 نقابة كونوها
⚙️ تطوير آرثر عمك
`.trim();

// ============================================================
// 🔒 حماية الجروب
// ============================================================

async function activateProtection(sock, jid, sender, detectedMessages) {

    console.log(
        `\n🚨 [SECURITY] تم تفعيل الحماية ضد: ${sender}`
    );

    // --------------------------------------------------------
    // 1️⃣ غلق الشات
    // --------------------------------------------------------

    try {
        await sock.groupSettingUpdate(jid, 'announcement');

        console.log('🔒 تم إغلاق الشات للمشرفين فقط.');
    } catch (error) {
        console.error(
            '⚠️ تعذر إغلاق الشات:',
            error.message
        );
    }

    // --------------------------------------------------------
    // 2️⃣ حذف الرسائل التي سببت التفعيل
    // --------------------------------------------------------

    for (const item of detectedMessages) {
        try {
            await sock.sendMessage(jid, {
                delete: item.key
            });

            console.log('🗑️ تم حذف رسالة جهة اتصال.');
        } catch (error) {
            console.error(
                '⚠️ تعذر حذف إحدى الرسائل:',
                error.message
            );
        }
    }

    // --------------------------------------------------------
    // 3️⃣ إرسال رسالة المكافحة
    // --------------------------------------------------------

    try {
        await sock.sendMessage(jid, {
            text: SECURITY_MESSAGE
        });

        console.log('📢 تم إرسال رسالة المكافحة.');
    } catch (error) {
        console.error(
            '⚠️ تعذر إرسال رسالة المكافحة:',
            error.message
        );
    }

    // --------------------------------------------------------
    // 4️⃣ طرد الشخص
    // --------------------------------------------------------

    try {
        await sock.groupParticipantsUpdate(
            jid,
            [sender],
            'remove'
        );

        console.log(
            `🚪 تم طرد العضو: ${sender}`
        );
    } catch (error) {
        console.error(
            '⚠️ تعذر طرد العضو:',
            error.message
        );
    }

    // تنظيف عداد الشخص
    clearTracker(sender);

    console.log(
        '✅ اكتملت عملية الحماية.\n'
    );
}

// ============================================================
// 🤖 تشغيل البوت
// ============================================================

async function startBot() {

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        CONFIG.AUTH_FOLDER
    );

    const {
        version
    } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,

        logger: pino({
            level: 'silent'
        }),

        auth: state,

        printQRInTerminal: false,

        generateHighQualityLinkPreview: false
    });

    // حفظ بيانات تسجيل الدخول
    sock.ev.on(
        'creds.update',
        saveCreds
    );

    // ========================================================
    // 📱 تسجيل الدخول عن طريق Pairing Code
    // ========================================================

    if (!sock.authState.creds.registered) {

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const question = text =>
            new Promise(resolve =>
                rl.question(text, resolve)
            );

        let phoneNumber = await question(
            '\n📱 ادخل رقم هاتف البوت مع رمز الدولة:\n> '
        );

        phoneNumber = phoneNumber.replace(
            /[^0-9]/g,
            ''
        );

        rl.close();

        setTimeout(async () => {

            try {

                const code =
                    await sock.requestPairingCode(
                        phoneNumber
                    );

                console.log(
                    '\n===================================='
                );

                console.log(
                    `🔐 رمز الاقتران: ${code}`
                );

                console.log(
                    '====================================\n'
                );

            } catch (error) {

                console.error(
                    '❌ فشل طلب رمز الاقتران:',
                    error.message
                );

            }

        }, 3000);
    }

    // ========================================================
    // 🔌 حالة الاتصال
    // ========================================================

    sock.ev.on(
        'connection.update',
        update => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === 'open') {

                console.log(
                    '\n===================================='
                );

                console.log(
                    '🟢 البوت متصل بنجاح!'
                );

                console.log(
                    '🛡️ نظام الحماية يعمل 24/7'
                );

                console.log(
                    '📇 نظام كشف جهات الاتصال مفعّل'
                );

                console.log(
                    '====================================\n'
                );
            }

            if (connection === 'close') {

                const shouldReconnect =
                    lastDisconnect?.error?.output
                        ?.statusCode !==
                    DisconnectReason.loggedOut;

                if (shouldReconnect) {

                    console.log(
                        '🔄 الاتصال انقطع، جاري إعادة الاتصال...'
                    );

                    setTimeout(
                        startBot,
                        3000
                    );

                } else {

                    console.log(
                        '🔴 تم تسجيل خروج البوت.'
                    );
                }
            }
        }
    );

    // ========================================================
    // 📨 استقبال الرسائل
    // ========================================================

    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }) => {

            // مهم جداً:
            // نراقب فقط الرسائل الجديدة التي تصل أثناء تشغيل البوت.
            if (type !== 'notify') {
                return;
            }

            for (const msg of messages) {

                try {

                    if (!msg.message) {
                        continue;
                    }

                    // رسائل البوت نفسه لا تدخل في الحماية
                    if (msg.key.fromMe) {
                        continue;
                    }

                    const jid =
                        msg.key.remoteJid;

                    // الحماية للجروبات فقط
                    if (!jid || !jid.endsWith('@g.us')) {
                        continue;
                    }

                    const sender =
                        msg.key.participant ||
                        msg.key.remoteJid;

                    if (!sender) {
                        continue;
                    }

                    const messageContent =
                        msg.message;

                    // =================================================
                    // 🛡️ فحص جهات الاتصال
                    // =================================================

                    const contactCount =
                        getContactCount(
                            messageContent
                        );

                    // ليست جهة اتصال → تجاهلها تماماً
                    if (contactCount <= 0) {
                        continue;
                    }

                    console.log(
                        `📇 جهة اتصال من ${sender} | العدد: ${contactCount}`
                    );

                    // تسجيلها في عداد صاحبها فقط
                    const result =
                        registerContactMessage(
                            sender,
                            msg,
                            contactCount
                        );

                    // لم يصل للحد المطلوب
                    if (!result.triggered) {
                        continue;
                    }

                    // =================================================
                    // 🚨 تم اكتشاف الحالة
                    // =================================================

                    await activateProtection(
                        sock,
                        jid,
                        sender,
                        result.messages
                    );
