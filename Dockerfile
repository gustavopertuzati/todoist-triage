# Image de production minimale pour l'application (aucune étape de build).
# Orkestr détecte ce Dockerfile et l'utilise à la place de son build automatique.

FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# On copie d'abord les manifestes pour profiter du cache de couches Docker.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Code applicatif uniquement (les tests et fichiers de dev restent dehors).
COPY server.js ./
COPY src ./src
COPY views ./views
COPY public ./public

# Carnet de notes persistant : le processus tourne en « node », il lui faut un
# dossier inscriptible (le système de fichiers du conteneur reste éphémère).
RUN mkdir -p /app/data && chown -R node:node /app/data

# L'utilisateur « node » existe déjà dans l'image officielle : pas de root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
