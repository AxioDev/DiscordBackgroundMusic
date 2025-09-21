# Dockerfile
FROM node:20-bullseye-slim

# en prod par défaut
ENV NODE_ENV=production
WORKDIR /usr/src/app

# installer ffmpeg (nécessaire pour la plupart des players / transcoders)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# copier package.json d'abord pour profiter du cache docker
COPY package*.json ./

# installer dépendances (production)
RUN npm ci --only=production

# copier le reste du projet
COPY . .

# créer un utilisateur non-root pour la sécurité
RUN groupadd -r app && useradd -r -g app app \
  && chown -R app:app /usr/src/app

USER app

# par défaut, lance ton script principal (index.js)
CMD ["node", "index.js"]
