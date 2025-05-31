// api/index.js (Votre fonction proxy Vercel)

const fetch = require('node-fetch');
const https = require('https');

// Agent HTTPS pour ignorer les erreurs de certificat SSL/TLS.
// À utiliser avec prudence en production, mais souvent utile pour les sources tierces non fiables.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

module.exports = async (req, res) => {
    // --- Configuration des en-têtes CORS pour le client (votre site web) ---
    // Ces en-têtes indiquent au navigateur que votre site est autorisé à recevoir des ressources de ce proxy.
    res.setHeader('Access-Control-Allow-Origin', '*'); // Autorise toutes les origines (préférable de spécifier votre domaine en production pour plus de sécurité)
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS'); // Méthodes HTTP autorisées
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization, If-None-Match, If-Modified-Since'); // En-têtes de requête autorisés
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges, ETag, Last-Modified'); // En-têtes de réponse à exposer au client
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache les informations CORS (requêtes OPTIONS) pendant 24 heures

    // --- Gestion des requêtes OPTIONS (preflight CORS) ---
    // Les navigateurs envoient une requête OPTIONS avant une requête réelle pour vérifier les permissions CORS.
    if (req.method === 'OPTIONS') {
        console.log('[Proxy Vercel] Requête OPTIONS (Preflight CORS) reçue.');
        return res.status(204).end(); // Répond avec un statut 204 No Content et les en-têtes CORS ci-dessus
    }

    // --- Récupération de l'URL cible depuis les paramètres de la requête ---
    const { url } = req.query;

    if (!url) {
        console.error('[Proxy Vercel] Erreur: Paramètre "url" manquant dans la requête.');
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl; // L'URL cible décodée

    try {
        decodedUrl = decodeURIComponent(url);
        console.log(`\n--- [Proxy Vercel] Nouvelle Requête Traitée ---`);
        console.log(`[Proxy Vercel] URL cible décodée: ${decodedUrl}`);
        console.log(`[Proxy Vercel] Méthode HTTP de la requête client: ${req.method}`);
        console.log(`[Proxy Vercel] En-têtes de la requête client:\n${JSON.stringify(req.headers, null, 2)}`);

        // Détermine si l'agent HTTPS doit être utilisé (pour les URL en HTTPS)
        const useHttpsAgent = decodedUrl.startsWith('https://');

        // --- Préparation des en-têtes à transmettre au serveur original ---
        const requestHeaders = {};
        const headersToForward = [
            'user-agent', 'accept', 'authorization', 'accept-language',
            'referer', 'origin', 'range', 'if-none-match', 'if-modified-since',
            'content-type', 'content-length', // Pour les requêtes POST/PUT/PATCH
            'cookie' // À utiliser avec prudence : peut transférer des cookies de l'utilisateur final au serveur cible
        ];

        headersToForward.forEach(headerName => {
            const clientHeaderValue = req.headers[headerName]; // `req.headers` est déjà en minuscules
            if (clientHeaderValue) {
                // Les clés d'en-tête pour `fetch` sont sensibles à la casse pour certaines, mais souvent tolérantes.
                // On normalise en utilisant la forme standard (ex: 'User-Agent' au lieu de 'user-agent').
                const normalizedHeaderName = headerName.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('-');
                requestHeaders[normalizedHeaderName] = clientHeaderValue;
                console.log(`[Proxy Vercel] Transmis '${normalizedHeaderName}': '${clientHeaderValue}'`);
            }
        });

        // Force 'Accept-Encoding' à 'identity' pour éviter la compression qui pourrait interférer avec le streaming vidéo
        requestHeaders['Accept-Encoding'] = 'identity';

        // Gère spécifiquement l'en-tête 'Range' pour les requêtes de fichiers vidéo
        // Une URL HLS (.m3u8) est un manifeste texte, le client ne devrait pas demander de range pour celui-ci.
        const urlPath = new URL(decodedUrl).pathname;
        const endsWithM3u8 = urlPath.toLowerCase().endsWith('.m3u8');

        if (req.headers['range'] && endsWithM3u8) {
            console.warn('[Proxy Vercel] En-tête Range ignoré pour un manifeste HLS. Le client ne devrait pas le demander pour le manifeste principal.');
            delete requestHeaders['Range']; // S'assurer que le range n'est pas envoyé
        } else if (req.headers['range']) { // Si un range est demandé et ce n'est pas un m3u8
            requestHeaders['Range'] = req.headers['range'];
            console.log('[Proxy Vercel] En-tête Range transmis.');
        }

        console.log(`[Proxy Vercel] En-têtes finaux envoyés au serveur original:\n${JSON.stringify(requestHeaders, null, 2)}`);

        // --- Effectue la requête au serveur original ---
        const response = await fetch(decodedUrl, {
            method: req.method, // Utilise la méthode HTTP de la requête cliente
            headers: requestHeaders, // Utilise les en-têtes préparés
            agent: useHttpsAgent ? httpsAgent : undefined, // Utilise l'agent HTTPS si nécessaire
            body: (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') ? req : undefined // Transmet le corps pour les requêtes avec corps
        });

        console.log(`[Proxy Vercel] Réponse du serveur original - Statut: ${response.status} ${response.statusText}`);
        console.log(`[Proxy Vercel] Réponse du serveur original - En-têtes:\n${JSON.stringify(Object.fromEntries(response.headers), null, 2)}`);

        // --- Gestion des erreurs de la réponse du serveur original ---
        if (!response.ok && response.status !== 206) { // 206 Partial Content est un succès pour les requêtes Range
            const errorBody = await response.text();
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}. Corps de l'erreur (extrait): ${errorBody.substring(0, 500)}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}. Details: ${errorBody.substring(0, 200)}...`);
        }

        // --- Transfert des en-têtes de réponse du serveur original au client ---
        // C'est crucial pour que le navigateur client puisse gérer le média correctement (taille, type, cache, etc.)
        response.headers.forEach((value, name) => {
            // Excluez les en-têtes qui pourraient causer des conflits ou qui sont déjà gérés par le proxy
            const excludedHeaders = [
                'access-control-allow-origin',
                'access-control-allow-methods',
                'access-control-allow-headers',
                'access-control-expose-headers',
                'access-control-max-age',
                'set-cookie', // La gestion des cookies via proxy est complexe et peut poser des problèmes de sécurité/vie privée
                'x-vercel-cache', // Spécifique à Vercel, pas nécessaire pour le client
                'cf-ray', 'x-cache' // En-têtes de CDN, non nécessaires pour le client final
            ];
            if (!excludedHeaders.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original (reçu): ${contentType}`);

        // Détection si le contenu est un manifeste HLS (M3U8)
        let isHlsManifestContent = false;
        if (contentType) {
            const normalizedContentType = contentType.toLowerCase().trim();
            isHlsManifestContent = (
                normalizedContentType.includes('application/x-mpegurl') ||
                normalizedContentType.includes('application/vnd.apple.mpegurl') ||
                (normalizedContentType.includes('text/plain') && endsWithM3u8) ||
                (normalizedContentType.includes('application/octet-stream') && endsWithM3u8)
            );
        }

        console.log(`[Proxy Vercel] Débogage détection de contenu:`);
        console.log(`[Proxy Vercel] - normalizedContentType: ${contentType ? contentType.toLowerCase().trim() : 'null'}`);
        console.log(`[Proxy Vercel] - endsWithM3u8: ${endsWithM3u8}`);
        console.log(`[Proxy Vercel] - isHlsManifestContent: ${isHlsManifestContent}`);
        console.log(`[Proxy Vercel] - response.status: ${response.status}`);
        console.log(`[Proxy Vercel] - Condition complète (isHlsManifestContent && response.status === 200): ${isHlsManifestContent && response.status === 200}`);

        // --- Logique de traitement des manifestes HLS vs. flux binaires (vidéo, audio, etc.) ---
        if (isHlsManifestContent && response.status === 200) {
            console.log('[Proxy Vercel] Manifeste HLS (200 OK) détecté. Lecture du corps pour réécriture des URLs...');
            const m3u8Content = await response.text();
            let modifiedM3u8Content = m3u8Content;

            const originalUrlObj = new URL(decodedUrl);
            const originalBaseUrl = originalUrlObj.protocol + '//' + originalUrlObj.host + originalUrlObj.pathname.substring(0, originalUrlObj.pathname.lastIndexOf('/') + 1);
            console.log(`[Proxy Vercel] Base URL pour résolution relative dans le manifeste: ${originalBaseUrl}`);

            // Regex complexe pour capturer et réécrire différentes formes d'URLs dans le manifeste HLS
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)([^#\n]+?\.(?:m3u8|ts|mp4|aac|mp3|key)(?:[?#][^\n]*)?\s*$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1_line_prefix, p2_standalone_url, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    let prefix = '';

                    if (p2_standalone_url) { // Cas 1: URL autonome sur sa propre ligne (ex: segment.ts)
                        originalPath = p2_standalone_url.trim();
                        prefix = p1_line_prefix;
                    } else if (p4_uri_path) { // Cas 2: URL dans URI="..." (ex: #EXT-X-KEY:URI="key.php")
                        originalPath = p4_uri_path.trim();
                        prefix = p3_uri_prefix;
                    } else if (p7_extinf_path) { // Cas 3: URL après #EXTINF: (moins commun pour les vidéos pures, mais possible)
                        originalPath = p7_extinf_path.trim();
                        prefix = p6_extinf_prefix;
                    }

                    // Ignorer si l'URL est un commentaire, déjà absolue, déjà proxyfiée, ou vide
                    if (!originalPath || originalPath.startsWith('#') || originalPath.startsWith('/api?url=') || originalPath.match(/^(https?:\/\/|data:)/)) {
                        console.log(`[Proxy Vercel]  - URL non modifiée (commentaire, absolue ou déjà proxyfiée): '${originalPath || match.substring(0, 50)}...'`);
                        return match;
                    }

                    let absoluteOriginalUrl;
                    try {
                        absoluteOriginalUrl = new URL(originalPath, originalBaseUrl).href; // Convertit le chemin relatif en URL absolue
                        console.log(`[Proxy Vercel]  - Résolution URL: '${originalPath}' (base: ${originalBaseUrl}) -> '${absoluteOriginalUrl}'`);
                    } catch (e) {
                        console.error(`[Proxy Vercel]  - Erreur de construction d'URL absolue: ${e.message} pour chemin: '${originalPath}' (base: ${originalBaseUrl})`);
                        absoluteOriginalUrl = originalPath; // En cas d'erreur, utilise le chemin original
                    }

                    // Vérification de double proxyfication après résolution absolue
                    if (absoluteOriginalUrl.includes('/api?url=') && absoluteOriginalUrl.includes(req.headers.host)) {
                            console.log(`[Proxy Vercel]  - URL déjà proxyfiée détectée après résolution: ${absoluteOriginalUrl}. Non modifiée.`);
                            return match;
                    }

                    // Construit la nouvelle URL proxyfiée
                    const proxifiedUrl = `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                    console.log(`[Proxy Vercel]  - URL proxyfiée: ${proxifiedUrl}`);

                    // Retourne la ligne modifiée en fonction du cas de capture original
                    if (p2_standalone_url) {
                        return `${prefix}${proxifiedUrl}`;
                    } else if (p4_uri_path) {
                        return `${p3_uri_prefix}${proxifiedUrl}${p5_uri_suffix}`;
                    } else if (p7_extinf_path) {
                        return `${p6_extinf_prefix}${proxifiedUrl}`;
                    }
                    return match; // Ne devrait jamais arriver si la regex est correcte
                }
            );

            // Définir le Content-Type pour le manifeste HLS
            res.setHeader('Content-Type', 'application/x-mpegurl'); // Standard pour les manifestes HLS
            res.status(200).send(modifiedM3u8Content); // Envoyer le manifeste réécrit
            console.log('[Proxy Vercel] Manifeste HLS réécrit et envoyé au client.');
            console.log('[Proxy Vercel] Manifeste réécrit (extrait):\n' + modifiedM3u8Content.substring(0, 500) + '...');

        } else {
            // --- Pour les contenus binaires (vidéo, audio, etc.) ---

            // Définir le Content-Type pour le client
            // Prioriser le Content-Type forcé pour les MP4 si la détection originale est incertaine,
            // sinon utiliser le Content-Type original ou le déduire de l'extension.
            if (decodedUrl.toLowerCase().endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
                console.log('[Proxy Vercel] Content-Type forcé à video/mp4 pour les URL se terminant par .mp4');
            } else if (contentType) {
                res.setHeader('Content-Type', contentType);
            } else if (endsWithM3u8) { // Fallback pour les .m3u8 qui ne sont pas 200 OK ou avec un type non standard (rare)
                res.setHeader('Content-Type', 'application/x-mpegurl');
            } else if (decodedUrl.toLowerCase().endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else if (decodedUrl.toLowerCase().endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac');
            } else if (decodedUrl.toLowerCase().endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            } else if (decodedUrl.toLowerCase().endsWith('.mkv')) {
                res.setHeader('Content-Type', 'video/x-matroska');
            } else if (decodedUrl.toLowerCase().endsWith('.key')) {
                res.setHeader('Content-Type', 'application/octet-stream');
            }

            // Transférer le statut HTTP de la réponse originale (y compris 206 Partial Content)
            res.status(response.status);

            // Pipe le corps de la réponse du serveur original directement au client.
            // Ceci est efficace pour les grands fichiers vidéo/audio.
            response.body.pipe(res);
            console.log(`[Proxy Vercel] Contenu binaire (type: ${res.getHeader('Content-Type') || 'inconnu'}, statut: ${response.status}) transféré directement au client.`);
        }

    } catch (error) {
        // --- Gestion des erreurs inattendues ---
        console.error(`[Proxy Vercel] Erreur inattendue dans le traitement de la requête: ${error.message}`);
        console.error(`[Proxy Vercel] Stack trace de l'erreur:\n${error.stack}`);
        res.status(500).send(`Proxy error: An unexpected error occurred: ${error.message}`);
    }
};
