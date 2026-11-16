# MeshByte: plan de implementación

Fork de MeshCentral 1.2.6 (Apache-2.0). Rama de producción `meshbyte-rebrand`.

## Principio: minimizar el coste de merge con upstream
Casi todo el diseño vive en ficheros que upstream no toca:
- `public/styles/custom.css` y `public/scripts/custom.js` (cargados siempre por `webserver.js`).
- `public/images/ik/*`, `public/fonts/*`, `public/images/meshbyte-mark.svg`.

Ficheros de upstream editados (puntos de conflicto al fusionar, mantener los cambios mínimos):
- `views/default3.handlebars`: etiquetas de navegación, enlace `LeftMenuMyPanel`, contenedor `#p7`.
- `views/login2.handlebars`: bloque `#mbHero` y título de la tarjeta.
- `config.json` (datos, fuera del repo): `title`, `title2`, `siteStyle: 3`.

## Procedimiento de actualización desde upstream
1. `git fetch upstream` y revisar el changelog de seguridad.
2. Fusionar en una rama aparte; resolver solo `default3.handlebars` y `login2.handlebars`.
3. Arrancar la instancia de desarrollo (puerto 8891) y comprobar login, dashboard, dispositivos y móvil.
4. Fast-forward a `meshbyte-rebrand`, reiniciar el servicio `MeshByte`.
5. No confirmar `agents/*.exe`: el servicio los regenera.

## Orden de trabajo
1. Hecho: tokens, tema oscuro/claro, login, Dashboard, dispositivos, cuenta, servidor, archivos, responsive.
2. Pendiente: Intel AMT, 404, mensajes, usuarios y eventos en móvil.
3. Pendiente: textos en español fuera del Dashboard (comprobar traducciones de MeshCentral).
4. Pendiente: Dashboard con agentes reales conectados.
5. Bloqueado por decisión: nombre y logo definitivos (búsqueda UKIPO/EUIPO), revisión legal, validación de demanda.

## Reglas de diseño
- Iconos solo IconKit, autoalojados (CSP no permite el CDN).
- Fuentes Inter y JetBrains Mono autoalojadas.
- Mapas: solo Leaflet con teselas OSM.
- Figma: https://www.figma.com/design/Yu5xqi27pWU04B7W4W0oPK
