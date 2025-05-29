const fetch = require('node-fetch');
const https = require('https');

// Crée un agent HTTPS qui ignore les erreurs de certificat SSL/TLS.
// À utiliser avec PRUDENCE en production. Pour un usage personnel, cela peut aider.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false // ATTENTION : Vulnérabilité potentielle.
});

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour permettre l'accès depuis n'importe quel client ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges');

    // Gère les requêtes OPTIONS (preflight CORS)
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    // --- Fin de la gestion CORS ---

    const { url } = req.query;

    // Vérifie si le paramètre 'url' est présent
    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl;

    try {
        decodedUrl = decodeURIComponent(url);
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // Détermine si l'agent HTTPS personnalisé doit être utilisé
        const useHttpsAgent = decodedUrl.startsWith('https://');

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Définit un User-Agent pour simuler une requête de navigateur standard
        requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        // Tente de définir le Referer sur l'origine du flux original.
        // C'est souvent crucial pour les plateformes de streaming pour des raisons de hotlinking.
        try {
             const originalUrlParsed = new URL(decodedUrl);
             // Utilise l'origine de l'URL du flux original comme Referer
             requestHeaders['Referer'] = originalUrlParsed.origin + '/';
        } catch (e) {
             console.warn(`[Proxy Vercel] Impossible de déterminer le Referer de l'URL originale (${decodedUrl}). Utilisation du Referer par défaut.`);
             // Fallback si l'URL est malformée ou si la détermination échoue
             requestHeaders['Referer'] = 'https://tesla-tv-proxy.vercel.app/'; // Remplacez par l'URL de votre propre frontend/proxy
        }

        // Transfère les en-têtes importants de la requête client
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range']; // Essentiel pour le streaming
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization']; // Si le flux nécessite une authentification

        // Définit l'en-tête Host pour correspondre au domaine du flux original
        requestHeaders['Host'] = new URL(decodedUrl).host;
        // Demande le contenu tel quel (pas de compression côté proxy)
        requestHeaders['Accept-Encoding'] = 'identity';
        // Maintient la connexion ouverte pour des requêtes consécutives (segments)
        requestHeaders['Connection'] = 'keep-alive';

        // --- Fin de la configuration des en-têtes ---

        // Exécute la requête vers l'URL du flux original
        const response = await fetch(decodedUrl, {
            method: req.method, // Utilise la même méthode HTTP que la requête client
            headers: requestHeaders, // Applique les en-têtes configurés
            agent: useHttpsAgent ? httpsAgent : undefined // Utilise l'agent SSL si l'URL est HTTPS
        });

        // Gère les erreurs de la requête vers le flux original
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        // --- Transfert des en-têtes de la réponse originale au client ---
        // Liste des en-têtes à exclure ou à gérer séparément pour éviter les conflits ou problèmes
        const headersToExclude = [
            'set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection',
            'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
            'content-encoding' // Exclure pour éviter des problèmes si le corps est modifié (ex: manifestes)
        ];

        response.headers.forEach((value, name) => {
            if (!headersToExclude.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });
        // --- Fin du transfert des en-têtes ---

        // --- Gestion spécifique du Content-Type et réécriture pour le streaming HLS ---
        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // Détecte si la réponse est un manifeste HLS
        const isHlsManifest = (contentType && (
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            (contentType.includes('text/plain') && decodedUrl.endsWith('.m3u8'))
        ));

        if (isHlsManifest) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text(); // Lit le contenu du manifeste
            let modifiedM3u8Content = m3u8Content;

            // Détermine l'URL de base pour résoudre les chemins relatifs dans le manifeste.
            // S'assure que l'originalBaseUrl se termine toujours par un '/' pour la résolution correcte.
            const originalBaseUrl = new URL(decodedUrl).protocol + '//' + new URL(decodedUrl).host + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Regex améliorée pour cibler toutes les URLs possibles dans un manifeste HLS :
            // 1. URLs sur une ligne autonome (segments, clés, etc.)
            // 2. URLs dans un attribut URI="..."
            // 3. URLs après la directive #EXTINF:
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)([^#\n]+?)(?=\s|$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1_line_prefix, p2_standalone_url, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    if (p2_standalone_url) { // Cas 1: URL autonome (ex: ../segment.mp4 ou https://absolut.m3u8)
                        originalPath = p2_standalone_url.trim();
                    } else if (p4_uri_path) { // Cas 2: URI dans une directive (URI="...")
                        originalPath = p4_uri_path.trim();
                    } else if (p7_extinf_path) { // Cas 3: URL après #EXTINF:
                        originalPath = p7_extinf_path.trim();
                    }

                    // Ne rien faire si :
                    // - Le chemin est vide
                    // - C'est une ligne de commentaire HLS (commence par #)
                    // - C'est déjà une URL proxyfiée par notre propre proxy
                    // - C'est déjà une URL absolue externe (commence par http(s):// ou data:)
                    if (!originalPath || originalPath.startsWith('#') || originalPath.startsWith('/api?url=') || originalPath.match(/^(https?:\/\/|data:)/)) {
                        return match; // Retourne le match original sans modification
                    }

                    let absoluteOriginalUrl;
                    try {
                        // Tente de construire une URL absolue.
                        // `new URL()` gère intelligemment les chemins relatifs et absolus par rapport à `originalBaseUrl`.
                        absoluteOriginalUrl = new URL(originalPath, originalBaseUrl).href;
                    } catch (e) {
                        console.error("[Proxy Vercel] Erreur de construction d'URL absolue:", e.message, "pour chemin:", originalPath, "avec base:", originalBaseUrl);
                        absoluteOriginalUrl = originalPath; // Fallback : utilise le chemin original si la résolution échoue
                    }
                    
                    // Si par hasard l'URL résultante est déjà notre URL de proxy, ne la touche pas
                    if (absoluteOriginalUrl.startsWith(req.headers.host) && absoluteOriginalUrl.includes('/api?url=')) {
                        return match;
                    }

                    // Construit la nouvelle URL proxyfiée
                    const proxifiedUrl = `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;

                    // Retourne la ligne modifiée selon le type de capture
                    if (p2_standalone_url) {
                        return `${p1_line_prefix}${proxifiedUrl}`;
                    } else if (p4_uri_path) {
                        return `${p3_uri_prefix}${proxifiedUrl}${p5_uri_suffix}`;
                    } else if (p7_extinf_path) {
                        return `${p6_extinf_prefix}${proxifiedUrl}`;
                    }
                    return match; // Cas de repli, ne devrait pas être atteint
                }
            );

            // Définit le Content-Type pour indiquer au client que c'est un manifeste HLS
            res.setHeader('Content-Type', 'application/x-mpegurl'); // Ou 'application/vnd.apple.mpegurl'

            // Envoie le contenu du manifeste modifié au client
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est PAS un manifeste HLS (probablement un segment vidéo/audio ou une clé),
            // on passe le corps de la réponse directement au client.
            if (contentType) {
                res.setHeader('Content-Type', contentType); // Conserve le Content-Type original
            } else if (decodedUrl.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            } else if (decodedUrl.endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac');
            } else if (decodedUrl.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            } else if (decodedUrl.endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
            } else if (decodedUrl.endsWith('.key')) { // Pour les clés de chiffrement (DRM)
                 res.setHeader('Content-Type', 'application/octet-stream');
            }

            // Transfère le flux binaire directement du serveur de streaming au client
            response.body.pipe(res);
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl || 'URL non définie'}`);
        // Envoie une réponse d'erreur au client
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};