# Image de production BacRush — un seul processus Node, état des parties en mémoire.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dépendances d'abord : cette couche est réutilisée tant que le verrou ne bouge pas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# L'hébergeur fournit le port via la variable PORT ; 3000 par défaut en local.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
