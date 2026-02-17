# Link Scraper

Headless browser (Puppeteer) для парсинга страниц товаров. Используется как fallback, когда Cloudflare Worker не может загрузить страницу (сайты вроде professor-e.com, 21vek.by).

## API

- **GET /?url=https://example.com/product** — рендер страницы, извлечение og:*, JSON-LD, возврат JSON `{ name, price, currency, size, link, image, imageBase64 }`
- **GET /health** — проверка работы сервиса

## Деплой на Railway

1. Залей репозиторий в GitHub
2. Railway → New Project → Deploy from GitHub → выбери link-scraper
3. Railway определит Dockerfile и соберёт образ
4. Добавь переменную `PORT` (Railway ставит автоматически)
5. Получи URL сервиса, например `https://link-scraper-xxx.up.railway.app`

## Интеграция с мини-апп (Cloudflare Worker)

1. Задеплой link-scraper на Railway
2. Скопируй URL сервиса (напр. `https://link-scraper-xxx.up.railway.app`)
3. В Cloudflare Pages → проект tg-wishlist → Settings → Environment variables:
   - Добавь `LINK_SCRAPER_URL` = `https://твой-link-scraper.up.railway.app`
4. Сделай redeploy мини-апп

Весь анализ ссылок выполняется только в link-scraper (Puppeteer). Worker — прокси к нему.
