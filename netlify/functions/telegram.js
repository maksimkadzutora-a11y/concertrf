// netlify/functions/telegram.js

const RATE_MAP = {};
const RATE_LIMIT = 10;
const RATE_WIN = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  if (!RATE_MAP[ip]) RATE_MAP[ip] = [];
  RATE_MAP[ip] = RATE_MAP[ip].filter(t => now - t < RATE_WIN);
  if (RATE_MAP[ip].length >= RATE_LIMIT) return true;
  RATE_MAP[ip].push(now);
  return false;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const Busboy = require('busboy');
    const bb = Busboy({ headers: event.headers });
    const fields = {};
    const files = [];

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => {
        files.push({
          fieldname: name,
          content: Buffer.concat(chunks),
          contentType: info.mimeType,
          filename: info.filename,
        });
      });
    });

    bb.on('finish', () => resolve({ fields, files }));
    bb.on('error', reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '');

    bb.write(body);
    bb.end();
  });
}

exports.handler = async (event) => {
  // Netlify использует event.httpMethod, не event.method
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    'unknown';

  if (isRateLimited(ip)) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Too Many Requests' }) };
  }

  const TGT = process.env.TG_TOKEN;
  const TGC = process.env.TG_CHAT_ID;

  if (!TGT || !TGC) {
    console.error('TG_TOKEN или TG_CHAT_ID не заданы в переменных окружения');
    return { statusCode: 500, body: JSON.stringify({ error: 'Bot not configured' }) };
  }

  const contentType = event.headers['content-type'] || '';

  try {
    // Текстовое сообщение
    if (contentType.includes('application/json')) {
      const body = JSON.parse(event.body);
      const text = body.text;
      if (!text) return { statusCode: 400, body: 'Missing text' };

      console.log('Отправка сообщения в Telegram:', text.substring(0, 80));

      const res = await fetch(`https://api.telegram.org/bot${TGT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TGC, text, parse_mode: 'HTML' }),
      });

      const data = await res.json();
      console.log('Ответ Telegram:', JSON.stringify(data));
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    // Фото (скриншот оплаты)
    if (contentType.includes('multipart/form-data')) {
      const { fields, files } = await parseMultipart(event);
      const photoFile = files.find(f => f.fieldname === 'photo');
      const caption = fields.caption || '';

      if (!photoFile) return { statusCode: 400, body: 'Missing photo' };

      console.log('Отправка фото в Telegram, размер:', photoFile.content.length);

      const fd = new FormData();
      fd.append('chat_id', TGC);
      fd.append('caption', caption);
      fd.append('photo', new Blob([photoFile.content], { type: photoFile.contentType }), 'pay.jpg');

      const res = await fetch(`https://api.telegram.org/bot${TGT}/sendPhoto`, {
        method: 'POST',
        body: fd,
      });

      const data = await res.json();
      console.log('Ответ Telegram (фото):', JSON.stringify(data));
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    return { statusCode: 400, body: 'Unsupported Content-Type' };

  } catch (err) {
    console.error('Telegram function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
