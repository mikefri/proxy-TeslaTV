// api/proxy.js

import fetch from 'node-fetch'; // Permet de faire des requêtes HTTP

export default async function handler(req, res) {
  // Gère les requêtes preflight OPTIONS pour CORS (obligatoire)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Ou spécifie 'https://mikefri.github.io'
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache la pré-vérification pendant 24h
    res.status(204).end();
    return;
  }

  // Récupère l'URL cible depuis le paramètre de requête 'url'
  // Exemple: /api/proxy?url=https://vavoo.to/play/4239659507/index.m3u8
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Le paramètre "url" est manquant.');
  }

  try {
    const isM3U8 = targetUrl.endsWith('.m3u8');
    const isTS = targetUrl.endsWith('.ts');

    // Effectue la requête HTTP vers la source originale (vavoo.to)
    const upstreamResponse = await fetch(targetUrl, {
      // Optionnel: Transfère les en-têtes Range si le client les envoie (important pour les .ts)
      headers: req.headers.range ? { 'Range': req.headers.range } : {}
    });

    if (!upstreamResponse.ok) {
      throw new Error(`Échec de la récupération depuis la source : ${upstreamResponse.status} ${upstreamResponse.statusText}`);
    }

    // Définit les en-têtes CORS pour autoriser ton site GitHub Pages à accéder à cette ressource
    res.setHeader('Access-Control-Allow-Origin', '*'); // Permet à n'importe quelle origine d'accéder (plus simple)
    // OU : res.setHeader('Access-Control-Allow-Origin', 'https://mikefri.github.io'); // Plus sécurisé, si tu veux cibler ton site précisément
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    // Expose ces en-têtes pour que le navigateur puisse les lire (essentiel pour le streaming)
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Content-Range');

    // Transfère les en-têtes pertinents de la réponse originale vers ton client
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const contentLength = upstreamResponse.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const acceptRanges = upstreamResponse.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    const contentRange = upstreamResponse.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    // --- Logique de réécriture pour les fichiers M3U8 ---
    if (isM3U8) {
      let m3u8Content = await upstreamResponse.text();

      // Construit l'URL de base de notre proxy Vercel pour la réécriture
      // Ex: https://ton-projet-vercel.vercel.app/api/proxy
      const proxyBaseUrl = `https://<span class="math-inline">\{req\.headers\.host\}</span>{req.url.split('?')[0]}`;

      // 1. Réécrit les URLs des segments .ts
      // Ceci va chercher les lignes qui se terminent par .ts (peu importe ce qu'il y a avant)
      m3u8Content = m3u8Content.replace(/^(#EXTINF:.*?)(\s*)([^#\s]+?\.ts)(\s*)$/gm, (match, extinfPart, space1, tsFileName, space2) => {
          // Résout le chemin relatif du .ts en URL absolue en utilisant l'URL originale du .m3u8 comme base
          const absoluteTsUrl = new URL(tsFileName.trim(), targetUrl).href;
          // Construit la nouvelle URL pour notre proxy, en encodant l'URL absolue du .ts
          const newTsUrl = `<span class="math-inline">\{proxyBaseUrl\}?url\=</span>{encodeURIComponent(absoluteTsUrl)}`;
          return `<span class="math-inline">\{extinfPart\}</span>{space1}<span class="math-inline">\{newTsUrl\}</span>{space2}`; // Reconstruit la ligne
      });

      // 2. Réécrit les URLs d'autres fichiers .m3u8 (par ex. pour les différentes qualités vidéo)
      // Ceci est crucial pour l'adaptive bitrate streaming (ABR)
      m3u8Content = m3u8Content.replace(/^(#EXT-X-STREAM-INF:.*?)(\s*)([^#\s]+?\.m3u8)(\s*)$/gm, (match, streamInfPart, space1, m3u8FileName, space2) => {
          const absoluteM3u8Url = new URL(m3u8FileName.trim(), targetUrl).href;
          const newM3u8Url = `<span class="math-inline">\{proxyBaseUrl\}?url\=</span>{encodeURIComponent(absoluteM3u8Url)}`;
          return `<span class="math-inline">\{streamInfPart\}</span>{space1}<span class="math-inline">\{newM3u8Url\}</span>{space2}`;
      });

      // 3. Réécrit les URLs des clés de chiffrement si elles existent (pour les flux chiffrés)
      m3u8Content = m3u8Content.replace(/^(#EXT-X-KEY:METHOD=[^,]+,URI=")([^"]+)"(.*?)$/gm, (match, prefix, keyUrl, suffix) => {
          const absoluteKeyUrl = new URL(keyUrl.trim(), targetUrl).href;
          const newKeyUrl = `<span class="math-inline">\{proxyBaseUrl\}?url\=</span>{encodeURIComponent(absoluteKeyUrl)}`;
          return `<span class="math-inline">\{prefix\}</span>{newKeyUrl}"${suffix}`;
      });


      // Envoie le contenu .m3u8 modifié au client
      res.status(200).send(m3u8Content);

    } else {
      // Pour les fichiers .ts (ou d'autres comme .key pour le DRM), on les streame directement
      // Cela permet au client de télécharger les segments vidéo et les clés
      upstreamResponse.body.pipe(res);
    }

  } catch (error) {
    console.error('Erreur du proxy:', error);
    res.status(500).send(`Erreur du proxy: ${error.message}`);
  }
}