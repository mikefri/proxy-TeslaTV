const fetch = require('node-fetch');
const https = require('https');

// Crée un agent HTTPS qui ignore les erreurs de certificat SSL/TLS.
// À utiliser avec PRUDENCE en production ! Pour le débogage et un usage personnel, cela peut aider.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false // ATTENTION : Vulnérabilité de sécurité. À désactiver en production si possible.
});

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour permettre l'accès depuis n'importe quel client ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges');

    // Gère les requêtes OPTIONS (preflight CORS)
    if (req.method === 'OPTIONS') {
        console.log('[Proxy Vercel] Requête OPTIONS (Preflight CORS) reçue.');
        return res.status(204).end();
    }
    // --- Fin de la gestion CORS ---

    const { url } = req.query;

    // Vérifie si le paramètre 'url' est présent
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


        // Détermine si l'agent HTTPS personnalisé doit être utilisé
        const useHttpsAgent = decodedUrl.startsWith('https://');

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Définit un User-Agent pour simuler une requête de navigateur standard
        requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        // Tente de définir le Referer sur l'origine du flux original.
        // C'est souvent crucial pour les plateformes de streaming.
        try {
             const originalUrlParsed = new URL(decodedUrl);
             // Option 1: Utilise l'origine de l'URL du flux original comme Referer (le plus courant)
             requestHeaders['Referer'] = originalUrlParsed.origin + '/';
             // Option 2: Si le précédent ne marche pas, essayez un Referer vide
             // requestHeaders['Referer'] = '';
             // Option 3: Si le précédent ne marche pas, essayez un Referer très générique
             // requestHeaders['Referer'] = 'https://www.google.com/';
        } catch (e) {
             console.warn(`[Proxy Vercel] Impossible de déterminer le Referer de l'URL originale (${decodedUrl}). Utilisation du Referer par défaut.`);
             // Fallback si l'URL est malformée ou si la détermination échoue
             requestHeaders['Referer'] = 'https://tesla-tv-proxy.vercel.app/'; // <<< REMPLACEZ PAR L'URL DE VOTRE PROXY VERCEL
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

        console.log(`[Proxy Vercel] En-têtes envoyés au serveur original:\n${JSON.stringify(requestHeaders, null, 2)}`);

        // --- Fin de la configuration des en-têtes ---

        // Exécute la requête vers l'URL du flux original
        const response = await fetch(decodedUrl, {
            method: req.method, // Utilise la même méthode HTTP que la requête client
            headers: requestHeaders, // Applique les en-têtes configurés
            agent: useHttpsAgent ? httpsAgent : undefined // Utilise l'agent SSL si l'URL est HTTPS
        });

        console.log(`[Proxy Vercel] Réponse du serveur original - Statut: ${response.status} ${response.statusText}`);
        console.log(`[Proxy Vercel] Réponse du serveur original - En-têtes:\n${JSON.stringify(Object.fromEntries(response.headers), null, 2)}`);


        // Gère les erreurs de la requête vers le flux original
        if (!response.ok) {
            const errorBody = await response.text(); // Tente de récupérer le corps de l'erreur
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}. Corps de l'erreur: ${errorBody}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}. Details: ${errorBody.substring(0, 200)}...`);
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
            console.log('[Proxy Vercel] Manifeste HLS détecté. Tentative de réécriture des URLs...');
            const m3u8Content = await response.text(); // Lit le contenu du manifeste
            let modifiedM3u8Content = m3u8Content;

            // Détermine l'URL de base pour résoudre les chemins relatifs dans le manifeste.
            // S'assure que l'originalBaseUrl se termine toujours par un '/' pour la résolution correcte.
            const originalBaseUrl = new URL(decodedUrl).protocol + '//' + new URL(decodedUrl).host + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);
            console.log(`[Proxy Vercel] Base URL pour résolution relative: ${originalBaseUrl}`);

            // Regex pour cibler toutes les URLs possibles dans un manifeste HLS :
            // 1. URLs sur une ligne autonome (segments, clés, sous-manifestes)
            // 2. URLs dans un attribut URI="..."
            // 3. URLs après la directive #EXTINF:
            modifiedM3u8Content = modifiedM3u8Content.replace(
                /(^|\n)([^#\n]+?)(?=\s|$)|(URI=")([^"]+?)(")|(#EXTINF:[^,\n]+,\s*)([^\n]+)/g,
                (match, p1_line_prefix, p2_standalone_url, p3_uri_prefix, p4_uri_path, p5_uri_suffix, p6_extinf_prefix, p7_extinf_path) => {
                    let originalPath = '';
                    // Détermine quel groupe de capture contient l'URL
                    if (p2_standalone_url) {
                        originalPath = p2_standalone_url.trim();
                    } else if (p4_uri_path) {
                        originalPath = p4_uri_path.trim();
                    } else if (p7_extinf_path) {
                        originalPath = p7_extinf_path.trim();
                    }

                    // Conditions pour ne PAS modifier l'URL :
                    // - Chemin vide
                    // - Ligne de commentaire HLS (commence par #)
                    // - URL déjà proxyfiée (par notre proxy)
                    // - URL absolue externe qui ne doit pas être traitée comme relative
                    if (!originalPath || originalPath.startsWith('#') || originalPath.startsWith('/api?url=') || originalPath.match(/^(https?:\/\/|data:)/)) {
                        console.log(`[Proxy Vercel]  - URL non modifiée (déjà absolue/proxy/commentaire): ${originalPath || match}`);
                        return match; // Retourne le match original sans modification
                    }

                    let absoluteOriginalUrl;
                    try {
                        // Tente de construire une URL absolue à partir du chemin original et de la base
                        absoluteOriginalUrl = new URL(originalPath, originalBaseUrl).href;
                        console.log(`[Proxy Vercel]  - Résolution URL: '${originalPath}' (base: ${originalBaseUrl}) -> '${absoluteOriginalUrl}'`);
                    } catch (e) {
                        console.error(`[Proxy Vercel]  - Erreur de construction d'URL absolue: ${e.message} pour chemin: '${originalPath}' (base: ${originalBaseUrl})`);
                        absoluteOriginalUrl = originalPath; // Fallback : utilise le chemin original si la résolution échoue
                    }
                    
                    // Une vérification de sécurité supplémentaire pour éviter le double proxy si la logique précédente a raté
                    if (absoluteOriginalUrl.includes('/api?url=') && absoluteOriginalUrl.includes(req.headers.host)) {
                         console.log(`[Proxy Vercel]  - URL déjà proxyfiée détectée après résolution: ${absoluteOriginalUrl}. Non modifiée.`);
                         return match;
                    }

                    // Construit la nouvelle URL proxyfiée
                    const proxifiedUrl = `/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                    console.log(`[Proxy Vercel]  - URL proxyfiée: ${proxifiedUrl}`);

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
            console.log('[Proxy Vercel] Manifeste HLS réécrit et envoyé au client.');

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
            console.log('[Proxy Vercel] Contenu non-manifeste transféré directement au client.');
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue dans le traitement: ${error.message}`);
        console.error(`[Proxy Vercel] Stack trace de l'erreur:\n${error.stack}`);
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};