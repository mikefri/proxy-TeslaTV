const fetch = require('node-fetch');
const https = require('https');

// Crée un agent HTTPS qui ignore les erreurs de certificat SSL/TLS.
// À utiliser avec PRUDENCE. En production, si possible, évitez rejectUnauthorized: false.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false // ATTENTION : Vulnérabilité de sécurité. À utiliser si absolument nécessaire.
});

module.exports = async (req, res) => {
    // --- Gestion des en-têtes CORS pour le client appelant le proxy ---
    // Permet à n'importe quelle origine d'accéder à ce proxy.
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Spécifie les méthodes HTTP autorisées.
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    // Spécifie les en-têtes autorisés dans les requêtes pré-vol (OPTIONS) et réelles.
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Range, Authorization');
    // Permet au navigateur de voir des en-têtes non standards (comme Range, Content-Length)
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Range, Accept-Ranges');

    // Gère les requêtes preflight OPTIONS envoyées par les navigateurs pour vérifier CORS.
    if (req.method === 'OPTIONS') {
        return res.status(204).end(); // Répond avec un statut 204 (No Content) et aucune donnée.
    }
    // --- Fin de la gestion CORS ---

    const { url } = req.query;

    // Vérifie si le paramètre 'url' est présent dans la requête.
    if (!url) {
        return res.status(400).send('Missing "url" query parameter.');
    }

    let decodedUrl;

    try {
        decodedUrl = decodeURIComponent(url); // Décode l'URL passée en paramètre.
        console.log(`[Proxy Vercel] Requête reçue pour le flux: ${decodedUrl}`);

        // Détermine si l'agent HTTPS personnalisé doit être utilisé (pour ignorer les erreurs SSL).
        // Il est utilisé uniquement si l'URL décodée est HTTPS.
        const useHttpsAgent = decodedUrl.startsWith('https://');

        // --- Configuration des en-têtes pour la requête sortante vers le serveur de streaming ---
        const requestHeaders = {};

        // Définit un User-Agent pour simuler une requête de navigateur.
        requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        // Définit l'en-tête Referer. Très important pour certains serveurs de streaming.
        // Remplacez 'https://tesla-tv-proxy.vercel.app/' par l'URL réelle de votre frontend
        // ou de votre proxy si cela s'avère nécessaire après des tests.
        requestHeaders['Referer'] = 'https://tesla-tv-proxy.vercel.app/';

        // Transfert d'autres en-têtes importants du client si présents, pour imiter une requête directe.
        if (req.headers['accept']) requestHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) requestHeaders['Accept-language'] = req.headers['accept-language'];
        if (req.headers['range']) requestHeaders['Range'] = req.headers['range']; // Important pour le streaming (lecture en continu, reprise)
        if (req.headers['authorization']) requestHeaders['Authorization'] = req.headers['authorization']; // Si le flux nécessite une authentification

        // Définit l'en-tête Host de la requête sortante à celui du domaine du flux original.
        requestHeaders['Host'] = new URL(decodedUrl).host;
        requestHeaders['Accept-Encoding'] = 'identity'; // Demande le contenu tel quel, sans compression si le client le gère.
        requestHeaders['Connection'] = 'keep-alive'; // Maintient la connexion ouverte.

        // --- Fin de la configuration des en-têtes ---

        // Exécuter la requête vers l'URL du flux original.
        const response = await fetch(decodedUrl, {
            method: req.method, // Utilise la même méthode HTTP que la requête client.
            headers: requestHeaders, // Applique les en-têtes configurés.
            agent: useHttpsAgent ? httpsAgent : undefined // Utilise l'agent SSL si nécessaire.
        });

        // Vérifier si la requête au flux original a réussi.
        if (!response.ok) {
            console.error(`[Proxy Vercel] Erreur lors de la récupération du flux original: ${response.status} ${response.statusText} pour URL: ${decodedUrl}`);
            return res.status(response.status).send(`Failed to fetch original stream: ${response.statusText}`);
        }

        // --- Transfert des en-têtes de la réponse originale au client ---
        // Liste des en-têtes à exclure ou à gérer séparément.
        const headersToExclude = [
            'set-cookie', 'x-powered-by', 'alt-svc', 'transfer-encoding', 'connection',
            'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
            'content-encoding' // Exclure pour éviter des problèmes si le corps est modifié (ex: manifestes)
        ];

        response.headers.forEach((value, name) => {
            // Transfert tous les en-têtes de la réponse originale, sauf ceux à exclure.
            if (!headersToExclude.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });
        // --- Fin du transfert des en-têtes ---

        // --- Gestion spécifique du Content-Type et réécriture pour le streaming HLS ---
        const contentType = response.headers.get('content-type');
        console.log(`[Proxy Vercel] Content-Type du flux original: ${contentType}`);

        // Logique de détection améliorée pour les manifestes HLS (.m3u8).
        // Prend en compte les Content-Type officiels ET 'text/plain' si l'URL se termine par .m3u8.
        const isHlsManifest = (contentType && (
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            (contentType.includes('text/plain') && decodedUrl.endsWith('.m3u8'))
        ));

        if (isHlsManifest) {
            console.log('[Proxy Vercel] Manifeste HLS détecté. Réécriture des URLs...');
            const m3u8Content = await response.text(); // Lit le contenu du manifeste.
            let modifiedM3u8Content = m3u8Content;

            // Détermine l'URL de base pour résoudre les chemins relatifs dans le manifeste.
            const originalBaseUrl = new URL(decodedUrl).origin + new URL(decodedUrl).pathname.substring(0, new URL(decodedUrl).pathname.lastIndexOf('/') + 1);

            // Réécrit toutes les URLs internes du manifeste pour qu'elles passent par le proxy.
            modifiedM3u8Content = modifiedM3u8Content.replace(
                // Nouvelle regex : Capture toute ligne qui n'est pas un commentaire HLS.
                // (.+?) capture l'URL ou la directive. (?=\s|$) assure que l'on capture jusqu'à un espace ou la fin de ligne.
                /(^|\n)(?!#)(.+?)(?=\s|$)/g,
                (match, p1, p2) => {
                    // Si la ligne est vide, ou une instruction HLS (commence par #EXT),
                    // ou si l'URL capturée est déjà une URL de proxy, on la laisse telle quelle.
                    if (!p2 || p2.startsWith('#EXT') || p2.startsWith('/api?url=') || p2.startsWith('http://' + req.headers.host + '/api?url=') || p2.startsWith('https://' + req.headers.host + '/api?url=')) {
                        return match;
                    }

                    let absoluteOriginalUrl;
                    try {
                        // Tente de construire une URL absolue si le chemin est relatif.
                        // La méthode URL() gère bien les cas où p2 est déjà une URL absolue.
                        absoluteOriginalUrl = new URL(p2, originalBaseUrl).href;
                    } catch (e) {
                        console.error("[Proxy Vercel] Erreur de construction d'URL absolue:", e.message, "pour chemin:", p2);
                        absoluteOriginalUrl = p2; // Fallback au cas où
                    }
                    // Retourne la nouvelle URL pointant vers le proxy, avec l'URL originale encodée.
                    // On utilise '/api?url=' qui sera résolu par le navigateur par rapport à la base de l'URL du proxy.
                    return `${p1}/api?url=${encodeURIComponent(absoluteOriginalUrl)}`;
                }
            );

            // Très important : Envoie le bon Content-Type au client pour que le navigateur/lecteur reconnaisse le manifeste HLS.
            res.setHeader('Content-Type', 'application/x-mpegurl'); // Ou 'application/vnd.apple.mpegurl'

            // Envoie le contenu du manifeste modifié au client.
            res.status(response.status).send(modifiedM3u8Content);

        } else {
            // Si ce n'est PAS un manifeste HLS (probablement un segment vidéo ou autre ressource),
            // on passe le corps de la réponse directement au client.
            // On s'assure d'envoyer un Content-Type approprié, même si l'original était générique.
            if (contentType) {
                res.setHeader('Content-Type', contentType); // Conserve le Content-Type original si valide.
            } else if (decodedUrl.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t'); // Fallback pour les segments .ts
            } else if (decodedUrl.endsWith('.aac')) {
                res.setHeader('Content-Type', 'audio/aac'); // Fallback pour l'audio .aac
            } else if (decodedUrl.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg'); // Fallback pour l'audio .mp3
            } else if (decodedUrl.endsWith('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4'); // Fallback pour la vidéo .mp4
            } else if (decodedUrl.endsWith('.key')) { // Pour les clés de chiffrement
                 res.setHeader('Content-Type', 'application/octet-stream');
            }


            // Transfère le flux binaire directement du serveur de streaming au client.
            response.body.pipe(res);
        }

    } catch (error) {
        console.error(`[Proxy Vercel] Erreur inattendue: ${error.message} pour URL: ${decodedUrl || 'URL non définie'}`);
        // Envoie une réponse d'erreur au client.
        res.status(500).send(`Proxy error: ${error.message}`);
    }
};