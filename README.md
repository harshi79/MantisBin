# MantisBin

**Stay sharp. Paste faster.**

A fast, minimal paste-sharing service with a clean dark-first design.

## Features

- Create pastes with optional titles
- Unique shareable URLs
- Public and unlisted visibility options
- Paste expiration (1 hour, 1 day, 1 week, 30 days, or never)
- Clean, responsive UI
- Rate limiting for abuse protection
- Server-side validation

## Quick Start

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

## Development

```bash
npm run dev
```

This enables auto-reload on file changes.

## API

### Create Paste

`POST /api/paste`

```json
{
  "title": "Optional title",
  "content": "Required content",
  "visibility": "public|unlisted",
  "expiresIn": 3600|86400|604800|2592000
}
```

### Get Paste

`GET /api/paste/:id`

Returns paste data or 404 if not found/expired.

## License

MIT
