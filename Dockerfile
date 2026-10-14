# Surge live console for one dispatch center.
#   docker build -t surge .
#   docker run -p 8080:8080 -v surge-data:/data -e SURGE_TOKENS="ana:<long random>,sam:<long random>" surge
# Dispatchers open http://<host>:8080/?token=<their token> once; the board survives restarts in the surge-data volume.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY dist/cli.js dist/surge.html dist/surge-austin.html ./dist/
COPY data/houston.json data/austin.json ./data/
ENV NODE_ENV=production
EXPOSE 8080
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
HEALTHCHECK --interval=1m --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# add --city data/austin.json for Austin, or mount your own city file
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8080", "--data", "/data"]
