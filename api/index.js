const fetch = require('node-fetch');
const https = require('https');

const httpsAgent = new https.Agent({
    rejectUnauthorized: false // Conserver pour le débogage, à évaluer pour la production.
});

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges');

    if (req.method === 'OPTIONS') {
        console.log('[Proxy Vercel] Requête OPTIONS (Preflight CORS) reçue.');
        return res.status(204).end();
    }

    const { url } = req.query;

    if (!url) {
        console.error('[Proxy Vercel] Erreur: Paramètre "url" manquant dans la requête.');
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl;

    try {
        decodedUrl = decodeURIComponent(url);
        console.log(`\n--- [Proxy Vercel] Nouvelle Requête ---`);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);
        console.log(`[Proxy Vercel] Méthode HTTP de la requête client: ${req.method}`);
        console.log(`[Proxy Vercel] En-têtes de la requête client:\n${JSON.stringify(req.headers, null, 2)}`);

        const useHttpsAgent = decodedUrl.startsWith('https://');

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Tente de ressembler à VLC ou une requête simple, sans Referer explicite
        requestHeaders['User-Agent'] = 'VLC/3.0.18 LibVLC/3.0.18'; // Simule le User-Agent de VLC
        // OU, pour ne pas envoyer de User-Agent spécifique, commentez la ligne ci-dessus
        // OU, pour laisser node-fetch mettre son User-Agent par défaut, n'ajoutez pas cette ligne.

        // NE PAS ENVOYER DE REFERER si VLC n'en envoie pas !
        // Si VLC n'envoie pas de Referer, tenter d'en envoyer un (même correct) peut être bloqué.
        // if (req.headers['referer']) requestHeaders['Referer'] = req.headers['referer']; // Option si vous voulez le transfert du Referer client
        // requestHeaders['Referer'] = ''; // Ou Referer vide

        // Transfert uniquement les en-têtes essentiels pour le streaming
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range']; // Crucial pour le streaming
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization']; // Pour les flux authentifiés

        // Laissez node-fetch gérer l'en-tête Host par défaut, souvent plus fiable.
        // requestHeaders['Host'] = new URL(decodedUrl).host; // Commenté car node-fetch le gère souvent bien.
        requestHeaders['Accept-Encoding'] = 'identity'; // Important pour ne pas avoir de compression inattendue
        requestHeaders['Connection'] = 'keep-alive';

        console.log(`[Proxy Vercel] En-têtes envoyés au serveur original:\n${JSON.stringify(requestHeaders, null, 2)}`);

        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: requestHeaders,
            agent: useHttpsAgent ? httpsAgent : undefined
        });

        console.log(`[Proxy Vercel] Réponse du serveur original - Statut: ${response.status} ${response.statusText}`);
        console.log(`[Proxy Vercel] Réponse du serveur original - En-têtes:\n${JSON.stringify(Object.fromEntries(response.headers), null, 2)}`);

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}. Corps de l'erreur: ${errorBody.substring(0, 500)}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}. Details: ${errorBody.substring(0, 200)}...`);
        }

        const headersToExclude = [
            'set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection',
            'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
            'content-encoding'
        ];

        response.headers.forEach((value, name) => {
            if (!headersToExclude.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        const isHlsManifest = (contentType && (
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            (contentType.includes('text/plain') && decodedUrl.endsWith('.m3u8')) ||
            (contentType.includes('application/octet-stream') && decodedUrl.endsWith('.m3u8'))
        ));

        if (isHlsManifest) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Tentative de réécriture des URLs...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            const originalBaseUrl = new URL(decodedUrl).protocol + '//' + new URL(decodedUrl).host + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);
            console.log(`[Proxy Vercel] Base URL pour résolution relative: ${originalBaseUrl}`);

            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(?:^|\n)([^#\n]+?\.(?:m3u8|ts|mp4|aac|mp3|key)(?:[?#][^\n]*)?\s*$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1_standalone_url, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    if (p1_standalone_url) {
                        originalPath = p1_standalone_url.trim();
                    } else if (p4_uri_path) {
                        originalPath = p4_uri_path.trim();
                    } else if (p7_extinf_path) {
                        originalPath = p7_extinf_path.trim();
                    }

                    if (!originalPath || originalPath.startsWith('#') || originalPath.startsWith('/api?url=') || originalPath.match(/^(https?:\/\/|data:)/)) {
                        console.log(`[Proxy Vercel]  - URL non modifiée (déjà absolue/proxy/commentaire): '${originalPath || match.substring(0, 50)}...'`);
                        return match;
                    }

                    let absoluteOriginalUrl;
                    try {
                        absoluteOriginalUrl = new URL(originalPath, originalBaseUrl).href;
                        console.log(`[Proxy Vercel]  - Résolution URL: '${originalPath}' (base: ${originalBaseUrl}) -> '${absoluteOriginalUrl}'`);
                    } catch (e) {
                        console.error(`[Proxy Vercel]  - Erreur de construction d'URL absolue: ${e.message} pour chemin: '${originalPath}' (base: ${originalBaseUrl})`);
                        absoluteOriginalUrl = originalPath;
                    }
                    
                    if (absoluteOriginalUrl.includes('/api?url=') && absoluteOriginalUrl.includes(req.headers.host)) {
                         console.log(`[Proxy Vercel]  - URL déjà proxyfiée détectée après résolution: ${absoluteOriginalUrl}. Non modifiée.`);
                         return match;
                    }

                    const proxifiedUrl = `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                    console.log(`[Proxy Vercel]  - URL proxyfiée: ${proxifiedUrl}`);

                    if (p1_standalone_url) {
                        return `${proxifiedUrl}`;
                    } else if (p4_uri_path) {
                        return `${p3_uri_prefix}${proxifiedUrl}${p5_uri_suffix}`;
                    } else if (p7_extinf_path) {
                        return `${p6_extinf_prefix}${proxifiedUrl}`;
                    }
                    return match;
                }
            );

            res.setHeader('Content-Type', 'application/x-mpegurl');
            res.status(response.status).send(modifiedM3u8Content);
            console.log('[Proxy Vercel] Manifeste HLS réécrit et envoyé au client.');
            console.log('[Proxy Vercel] Manifeste réécrit (extrait):\n' + modifiedM3u8Content.substring(0, 500) + '...');

        } else {
            if (contentType) {
                res.setHeader('Content-Type', contentType);
            } else if (decodedUrl.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else if (decodedUrl.endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac');
            } else if (decodedUrl.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            } else if (decodedUrl.endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
            } else if (decodedUrl.endsWith('.key')) {
                 res.setHeader('Content-Type', 'application/octet-stream');
            }

            response.body.pipe(res);
            console.log('[Proxy Vercel] Contenu non-manifeste transféré directement au client.');
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue dans le traitement: ${error.message}`);
        console.error(`[Proxy Vercel] Stack trace de l'erreur:\n${error.stack}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};