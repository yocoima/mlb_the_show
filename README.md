# MLB The Show 26 Scanner

Gestion de XP, objetivos y cartas con una aplicacion web basada en Express y Playwright para escanear programas de MLB The Show 26 y mostrar las misiones pendientes en una tabla.

## Requisitos

- Node.js 18 o superior
- Dependencias instaladas con `npm install`

## Uso local

```bash
npm install
npx playwright install chromium
npm start
```

Luego abre `http://localhost:3000`.

En local, Playwright abre una ventana visible para que puedas iniciar sesion manualmente. En Render, el navegador corre en modo headless.

## Despliegue en Render

El archivo `render.yaml` ya incluye:

- `buildCommand`: `npm install && npx playwright install --with-deps chromium`
- `startCommand`: `npm start`
- `NODE_ENV=production`

Tambien puedes crear el servicio manualmente con esos mismos valores.
