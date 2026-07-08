# Ticket Témoin

Vérifie que le prix facturé sur ton ticket de caisse correspond au prix affiché
en rayon (arrêté n°170 CM, Polynésie française). Site 100% autonome : pas de
build, pas de framework, une clé Qwen cachée côté serveur.

## Structure

```
index.html            page principale
css/style.css          styles (palette navy/sable/corail/turquoise)
js/app.js               logique de l'interface
js/image-compress.js    compression des photos avant envoi
js/ticket-api.js        appels vers /api/scan et /api/match
js/ticket-history.js    historique + articles fréquents (localStorage)
functions/api/scan.js   fonction serveur : lit étiquette ou code-barre via Qwen
functions/api/match.js  fonction serveur : compare le ticket au reçu final
```

## Déployer sur Cloudflare Pages (recommandé, gratuit)

1. Crée un dépôt Git (GitHub/GitLab) avec ce dossier, ou utilise l'upload direct.
2. Sur https://dash.cloudflare.com → **Workers & Pages** → **Créer** → **Pages**
   → **Connecter un dépôt Git** (ou "Upload assets" pour un déploiement direct
   sans Git).
3. Build settings : **aucun build nécessaire**. Laisse "Build command" vide et
   "Build output directory" sur `/` (racine du dossier).
4. Une fois le projet créé, va dans **Settings → Environment variables** et
   ajoute :
   - `QWEN_API_KEY` = ta clé Qwen (coche "Encrypt" pour qu'elle reste secrète)
   - `QWEN_BASE_URL` = `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
     (ou l'endpoint Chine continentale si ta clé y a été créée)
5. Redéploie (Cloudflare redéploie automatiquement après un changement de
   variables, sinon relance un déploiement manuellement).

Ton site est en ligne à `https://<nom-du-projet>.pages.dev`. Tu peux ensuite
attacher un domaine personnalisé dans **Custom domains**.

### Tester en local avant de déployer

```bash
npx wrangler pages dev . --binding QWEN_API_KEY=ta_clé --binding QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

## Déployer ailleurs (Vercel, Netlify)

Le HTML/CSS/JS du dossier racine est déployable tel quel sur n'importe quel
hébergeur statique. Les deux fichiers dans `functions/api/` utilisent le
format **Cloudflare Pages Functions** ; pour Vercel ou Netlify, il faut les
adapter au format serverless propre à chacun (la logique interne, elle, reste
identique) :

- **Vercel** : déplacer vers `api/scan.js` / `api/match.js`, changer
  `export async function onRequestPost({ request, env })` en
  `export default async function handler(req, res)` et lire les variables via
  `process.env.QWEN_API_KEY`.
- **Netlify** : déplacer vers `netlify/functions/scan.js` / `match.js`, changer
  la signature en `exports.handler = async (event) => {...}` et lire les
  variables via `process.env.QWEN_API_KEY`.

Dis-le-moi si tu veux que je fasse cette adaptation pour l'un de ces deux
hébergeurs en particulier.

## Ajouter de la publicité plus tard

Deux emplacements neutres sont déjà prévus dans `index.html`, cachés par
défaut (`hidden`) :

- `#ad-slot-header` (juste sous l'intro, pleine largeur, format bannière)
- `#ad-slot-content` (en bas, avant le pied de page, format natif/display)

Pour activer un réseau publicitaire (Google AdSense, etc.) : colle son script
d'intégration à l'intérieur de la div correspondante dans `index.html`, puis
retire l'attribut `hidden`. Le CSS (`.ad-slot` dans `style.css`) donne un
cadre neutre par défaut ; adapte-le au format exact fourni par le réseau
choisi.

## Notes

- Aucune clé API n'est jamais exposée au navigateur : `js/ticket-api.js`
  n'appelle que `/api/scan` et `/api/match`, qui tournent côté serveur.
- L'historique et les articles fréquents restent uniquement sur l'appareil de
  l'utilisateur (`localStorage`), rien n'est envoyé à un serveur pour ça.
- Les photos sont compressées côté navigateur avant l'envoi (1600px max,
  JPEG qualité 82%) pour rester rapide et léger.
