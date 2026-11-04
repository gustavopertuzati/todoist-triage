# Triage pour Todoist

Petite application web personnelle, pensée d'abord pour le téléphone, qui lit un compte
Todoist surchargé et aide à y voir clair.

**En ligne :** <https://todoist-triage.orkestr.run> (instance configurée sur
`Europe/Zurich`). Code : <https://github.com/gustavopertuzati/todoist-triage>.

> **Itérations 1 à 8.** L'app affiche un résumé, explore les projets, **diagnostique chaque
> projet**, et te laisse **planifier jour par jour** : tu choisis un jour, réponds à un
> **check-in de 5 questions** (énergie, forme, temps, envie, humeur), et une **IA**
> (OpenRouter, `deepseek/deepseek-v4.1-flash`) propose les tâches les plus adaptées à ton
> état, en respectant une **charge 1-3-5** et en te proposant de **reporter** si nécessaire.
> Un **nettoyage guidé** repère les projets morts, doublons, tâches fantômes et orphelines,
> **avec corbeille réversible**. Tu **valides ou ignores chaque proposition
> individuellement**. Tant que tu n'as pas validé, **rien n'est écrit dans Todoist** ;
> chaque écriture validée est ensuite relue depuis l'API.
>
> La référence de date est l'**échéance native Todoist**. Les dates écrites dans les titres
> (`JJ.MM.AAAA`, `auj`) restent détectées et affichées passivement, mais ne sont pas la
> cible de travail retenue.

## Ce que fait l'application

- Connexion par un mot de passe unique (cookie de session signé, `HttpOnly`).
- Lecture de **tous** les projets, sections, tâches actives, labels et du profil via un
  *full sync* officiel de l'API Todoist v1.
- Lecture des tâches terminées des 90 derniers jours (indicateur d'activité ; un échec de
  cet appel n'empêche pas l'export).
- Résumé : nombre de projets, tâches par projet, tâches en retard, projets vides,
  projets « sans progression », tâches sans échéance, tâches anciennes.
- **Diagnostic des projets** : chaque projet actif reçoit un verdict (vide, sans
  progression, retards accumulés, beaucoup sans échéance, surchargé, aucune activité
  récente, ou sain), une liste de signaux chiffrés et une **proposition de nettoyage**.
  Les projets sont classés du plus préoccupant au plus sain, avec des filtres par type
  d'action. Voir « Itération 2 » ci-dessous.
- **Propositions validables une par une** : chaque carte se valide (ou s'ignore)
  individuellement, puis l'écriture est vérifiée via l'API. Voir « Itération 3 ».
- **Planification jour par jour assistée par une IA** : tu cliques un jour, réponds à un
  **check-in de 5 questions** (état/humeur), et l'IA propose les tâches adaptées à ton état
  (avec taille et justification), peut **reporter** ce qui dépasse et **scinder** une grosse
  tâche. Voir « Itérations 5 à 7 ».
- Détection de la convention de date en **fin de titre** :
  - `11.10.2026` → échéance `2026-10-11` ;
  - `auj` / `auj.` → aujourd'hui, dans le fuseau configuré.
  Le titre affiché est nettoyé, et la date dérivée est marquée `needs_apply` (à appliquer
  plus tard, avec confirmation).
- Explorateur par projet, avec sections, sous-tâches et recherche.
- Téléchargement d'une sauvegarde JSON horodatée (`todoist-export-AAAA-MM-JJ-HHMM.json`)
  contenant les données brutes **et** les champs dérivés.
- Aucune donnée persistée côté serveur : l'export est généré à la demande et téléchargé
  par le navigateur. Un cache mémoire de 60 secondes évite de marteler l'API.

Les projets et tâches archivés sont présents dans l'export JSON mais exclus des compteurs
et de l'explorateur.

## Itération 2 — diagnostic des projets

Chaque projet actif est analysé et reçoit un **verdict** unique (le signal le plus grave)
et une **proposition de nettoyage** :

| Verdict | Déclencheur | Proposition |
| --- | --- | --- |
| Projet vide | aucune tâche active (hors Inbox) | Archiver ou supprimer |
| Sans progression | tâches actives, 0 terminée sur la fenêtre, projet âgé | Réviser ou archiver |
| Retards accumulés | au moins 5 tâches en retard | Rattraper les retards |
| Beaucoup sans échéance | ≥ 10 tâches et ≥ 60 % sans échéance | Donner des échéances |
| Aucune activité récente | dernière activité il y a ≥ 60 jours | Décider du sort du projet |
| Projet surchargé | au moins 50 tâches actives | Découper et prioriser |
| Sain | aucun signal | Rien à faire |

Les seuils vivent dans `src/diagnosis.js` (`THRESHOLDS`) et sont volontairement simples.
Le diagnostic reste **indicatif** ; les modifications concrètes passent par les
propositions de l'itération 3.

## Itération 3 — propositions validées individuellement

L'app génère une liste d'actions concrètes et réversibles. Chaque carte propose une
modification précise, avec sa raison et son aperçu, et se **valide individuellement** :

| Type | Cible | Action appliquée |
| --- | --- | --- |
| Reporter | tâche en retard | échéance → aujourd'hui |
| Dater | tâche ancienne sans échéance | échéance → date proposée (modifiable) |
| Scinder | tâche dont la note contient une liste à puces | une sous-tâche par élément, note nettoyée |
| Archiver | projet vide ou sans progression (hors Inbox) | projet archivé (réversible) |

Garde-fous :

- Le serveur ne fait **aucune** écriture tant qu'une proposition n'est pas validée.
- Une proposition validée est **recalculée** sur un instantané frais : si elle n'est plus
  d'actualité (tâche modifiée entre-temps), l'application répond `409` et ne touche à rien.
- Après écriture, la ressource est **relue** via l'API pour confirmer l'effet (échéance,
  archivage, sous-tâches créées).
- Le bouton **Ignorer** masque durablement une proposition (stockage local du navigateur).
- `WRITES_ENABLED=false` coupe toutes les écritures côté serveur.

Détails d'implémentation : `src/proposals.js` (génération, pure et testée) et
`src/applyProposal.js` (exécution + vérification). Les écritures ne sont possibles que
pour une proposition présente dans l'instantané courant : aucune action arbitraire n'est
acceptée.

## Itérations 5 à 7 — planification par jour, charge 1-3-5 et check-in

Depuis l'itération 5, l'IA ne propose plus un lot global : on planifie **un jour à la fois**.

1. L'app calcule un **plan de charge** des 14 prochains jours à partir des échéances
   existantes, en estimant la taille de chaque tâche (durée renseignée, sinon nombre de
   sous-tâches et longueur de la note) : **Gros (L) / Moyen (M) / Petit (S)**.
2. Une journée saine respecte la règle **1-3-5** : au plus **1 grosse, 3 moyennes et
   5 petites** tâches. Une bande **« Charge par jour »** affiche, pour chaque jour, ce qui
   est déjà posé et ce qu'il reste.
3. Tu **cliques sur un jour**. L'app t'indique la **place restante** et demande à l'IA
   quelles tâches conviennent le mieux à **cette journée précise**, sans dépasser la place.
4. Tu valides ou ignores chaque carte, puis tu passes à un autre jour. Valider une carte
   n'affecte **pas** les autres : la place du jour est simplement recalculée.
5. L'IA peut aussi proposer de **scinder** une grosse tâche en 2 à 10 sous-tâches.

### Check-in du jour (itération 7)

Avant de planifier, tu peux répondre à **5 questions rapides** : énergie, forme, temps
disponible, envie, humeur. Par exemple, si tu te sens **malade et épuisé** :

- la **charge autorisée** de la journée est fortement réduite (ex. « 0 gros · 0 moyens ·
  3 petits », plafonnée par le temps disponible) ;
- l'IA ne propose alors **que des tâches légères**, et surtout **de proposer de reporter**
  les tâches déjà prévues ce jour vers des jours qui ont de la place ;
- l'interface affiche l'**objectif du jour**, les consignes liées à ton état et un
  avertissement si la journée dépasse encore cette charge.

Le check-in est **mémorisé par jour** dans ton navigateur ; tu peux le modifier à tout
moment et cliquer **« Adapter ma journée »** pour re-planifier.

Chaque jour a son propre cache (empreinte des données **et du check-in**) : revenir sur un
jour ne rappelle pas le modèle. Les cartes déjà affichées restent validables même après une
écriture (magasin en mémoire 2 h), donc plus de « cette proposition n'est plus
d'actualité » parce qu'une autre a été validée.

Le modèle répond uniquement par un JSON :

```json
{
  "summary": "Journée allégée : repos, peu de tâches, et reports à droite.",
  "proposals": [
    { "task_id": "…", "due_date": "2026-11-05", "size": "S", "reason": "…", "group": "Admin" }
  ],
  "defer": [
    { "task_id": "…", "due_date": "2026-11-09", "reason": "à reporter, journée trop chargée" }
  ],
  "splits": [
    { "task_id": "…", "reason": "…", "subtasks": ["…", "…"] }
  ]
}
```

Garde-fous : l'IA ne peut produire que des échéances (`set_due_date`, bornées au jour choisi
pour les ajouts, à la charge autorisée) et des reports (`defer`, bornés à la place des jours
cibles), plus des scissions (`split_task`). Tout dépassement ou cible inconnue est
**écarté** côté serveur. Aucune donnée sensible n'est envoyée (titres, métadonnées, date,
réponses au check-in). Sans clé (`AI_ENABLED=false`), l'app fonctionne en mode règles.

Le panneau **« Autres propositions »** regroupe les actions non liées à une date : archiver
un projet vide ou dormant, scinder une tâche dont la note est une liste, reporter un retard.

Seuils configurables : `CAPACITY_HORIZON_DAYS`, `CAPACITY_MAX_LARGE`,
`CAPACITY_MAX_MEDIUM`, `CAPACITY_MAX_SMALL`, `AI_ALLOW_SPLITS`, `AI_MAX_TOKENS`,
`AI_REASONING_MAX_TOKENS` (plafond de réflexion du modèle), `AI_CACHE_TTL_MINUTES`.

Les propositions IA **remplacent** l'ancienne règle « datation en vrac » (qui mettait tout
à la même date) : la datation par règles est désactivée dès que l'IA est active.

## Itération 8 — nettoyage guidé

Le panneau **« Nettoyage guidé »** recense les tâches à écarter, de la plus à la moins
importante. Quatre catégories sont détectées :

| Catégorie | Déclencheur | Action proposée |
| --- | --- | --- |
| Projets morts | projet sans tâche active ou sans progression sur 90 j (hors Inbox) | Archiver (réversible) |
| Doublons | titres quasi identiques (accents/casse/URL ignorés) dans un même projet | Supprimer le doublon le moins riche |
| Tâches fantômes | tâche très ancienne (≥ 365 j), sans échéance, jamais modifiée | Supprimer (abandonner) |
| Tâches orphelines | tâche dont le projet n'existe plus | Supprimer |

Garde-fous de la suppression :

- Chaque suppression part vers Todoist **uniquement après validation** individuelle.
- La tâche est d'abord placée en **corbeille** (mémoire serveur, 24 h) : tu peux la
  **restaurer à l'identique** à tout moment depuis l'interface (bouton **« Annuler
  (restaurer) »**).
- La **relecture** confirme que la tâche a bien disparu.
- Les seuils sont configurables : `CLEANUP_GHOST_DAYS` (365), `CLEANUP_MAX_PER_KIND` (10),
  `CLEANUP_MAX_TOTAL` (25). La détection se désactive avec `CLEANUP_ENABLED=false`.

Implémentation : `src/proposals.js` (`buildCleanupTasks`) pour la détection et
`src/recycleBin.js` pour la corbeille. La détection de doublons est pure et testée.

## Itération 9 — confort d'usage

Trois ajouts pour un usage plus agréable, notamment sur mobile.

### Tout valider
Dans un plan du jour, un bouton **« Tout valider (n) »** applique d'un coup toutes les
propositions en attente de ce jour (ajouts, reports, scissions). Chacune passe par le même
garde-fou que d'habitude (validation + relecture + corbeille si suppression) ; si l'une
expire, l'application s'arrête et recharge proprement.

### PWA / appli installable
L'app est une **PWA** : sur ton téléphone, « Ajouter à l'écran d'accueil » l'installe comme
une vraie app en plein écran. Un service worker met en cache le « shell » (pages, CSS, JS)
pour un démarrage rapide et une disponibilité hors-ligne limitée ; les données Todoist et
la session ne sont **jamais** mises en cache.

- `public/manifest.webmanifest` (nom, icônes, affichage standalone)
- `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`
- `public/sw.js` (service worker)
- Balises `<meta name="mobile-web-app-capable">`, `apple-mobile-web-app-capable`, icône
  Apple, manifest.

### Récap de la semaine
Sous le planificateur, un **récap** de la semaine courante : nombre de journées, tâches
planifiées, jours libres / complets, et le jour le plus chargé — avec un conseil si la
semaine est dense.

Seuil : aucun (calculé à partir de la charge). Aucune donnée persistée de plus côté serveur.

## Prérequis

- Node.js **22 ou plus** (testé avec Node 22).
- Un compte Todoist personnel.
- Un jeton API Todoist : *Paramètres → Intégrations → Développeur → Jeton API*.
  - Itérations 1–2 (lecture) : `data:read` suffit.
  - Itération 3 (écritures) : `data:read_write`. Un jeton personnel couvre déjà tout.

## Installation locale

```powershell
npm install
Copy-Item .env.example .env
# édite .env : TODOIST_API_TOKEN, APP_PASSWORD, SESSION_SECRET
node --env-file=.env server.js
```

L'application écoute sur <http://localhost:3000>. Sur mobile, depuis le même réseau Wi-Fi,
utilise l'adresse IP locale de la machine (`http://192.168.x.x:3000`).

Autre possibilité : définir les variables dans le terminal puis lancer `npm run dev`
(redémarrage automatique à chaque modification) :

```powershell
$env:TODOIST_API_TOKEN = "ton-jeton"
$env:APP_PASSWORD = "un-mot-de-passe-long"
$env:SESSION_SECRET = "une-chaine-aleatoire"
npm run dev
```

## Variables d'environnement

| Variable | Obligatoire | Défaut | Rôle |
| --- | --- | --- | --- |
| `TODOIST_API_TOKEN` | oui | — | Jeton API Todoist, utilisé uniquement côté serveur. |
| `APP_PASSWORD` | oui | — | Mot de passe d'accès à l'application (12 caractères minimum conseillés). |
| `SESSION_SECRET` | recommandé | dérivé de `APP_PASSWORD` | Clé HMAC qui signe le cookie de session. |
| `APP_TIMEZONE` | non | `Europe/Paris` | Fuseau pour « aujourd'hui » et l'horodatage des exports. |
| `PORT` | non | `3000` | Port d'écoute (Orkestr l'injecte automatiquement). |
| `SESSION_TTL_DAYS` | non | `30` | Durée de validité de la session. |
| `CACHE_TTL_SECONDS` | non | `60` | Durée du cache mémoire (`0` pour désactiver). |
| `COMPLETED_LOOKBACK_DAYS` | non | `90` | Fenêtre d'analyse des tâches terminées (max. 92). |
| `PROJECT_NO_PROGRESS_DAYS` | non | `30` | Âge minimum d'un projet « sans progression ». |
| `OLD_TASK_DAYS` | non | `180` | Seuil d'ancienneté d'une tâche. |
| `WRITES_ENABLED` | non | `true` | Autorise les écritures Todoist **après validation** d'une proposition. `false` = lecture seule. |
| `PROPOSALS_MAX_PER_TYPE` | non | `15` | Nombre maximum de propositions par type. |
| `PROPOSALS_MAX_TOTAL` | non | `40` | Nombre maximum de propositions affichées au total. |
| `PROPOSAL_DUE_OFFSET_DAYS` | non | `7` | Décalage par défaut proposé pour dater une tâche ancienne. |
| `OPENROUTER_API_KEY` | non | — | Clé OpenRouter. Sans elle, l'IA est désactivée (mode règles). |
| `AI_MODEL` | non | `deepseek/deepseek-v4.1-flash` | Modèle utilisé pour proposer les échéances. |
| `AI_MAX_TOKENS` | non | `8000` | Budget de génération (raisonnement + JSON). |
| `AI_REASONING_MAX_TOKENS` | non | `400` | Plafond du raisonnement du modèle. |
| `AI_MAX_PROPOSALS` | non | `5` | Nombre maximum de propositions pour un jour donné. |
| `AI_TIMEOUT_MS` | non | `90000` | Délai maximal d'un appel au modèle. |
| `AI_CACHE_TTL_MINUTES` | non | `30` | Durée de cache des propositions IA. |
| `AI_ENABLED` | non | `true` | `false` désactive l'IA même si la clé est présente. |
| `CAPACITY_HORIZON_DAYS` | non | `14` | Nombre de jours couverts par le plan de charge. |
| `CAPACITY_MAX_LARGE` | non | `1` | Nombre maximum de grosses tâches par jour. |
| `CAPACITY_MAX_MEDIUM` | non | `3` | Nombre maximum de tâches moyennes par jour. |
| `CAPACITY_MAX_SMALL` | non | `5` | Nombre maximum de petites tâches par jour. |
| `AI_ALLOW_SPLITS` | non | `true` | Autorise l'IA à proposer de scinder une grosse tâche. |
| `CLEANUP_ENABLED` | non | `true` | Active la détection de nettoyage (doublons, fantômes, orphelines). |
| `CLEANUP_GHOST_DAYS` | non | `365` | Âge minimum pour déclarer une tâche « fantôme ». |
| `CLEANUP_MAX_PER_KIND` | non | `10` | Nombre maximum de suppressions proposées par catégorie. |
| `CLEANUP_MAX_TOTAL` | non | `25` | Nombre maximum total de suppressions proposées. |
| `TODOIST_BASE_URL` | non | API officielle | Surcharge réservée aux tests locaux avec un faux Todoist. |

Toutes les valeurs sensibles sont lues uniquement depuis l'environnement du serveur.
Elles ne sont jamais envoyées au navigateur, journalisées ou incluses dans l'export.

Générer une clé de session :

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Tests

```powershell
npm test
```

Les tests unitaires couvrent l'analyse des dates de titre, la construction du résumé
(filtrage des archives, cas de date invalide), le diagnostic des projets (signaux,
verdicts, agrégation par action), le moteur de propositions (liste à puces, échéances,
plafonds, identifiants stables), la couche IA (parsing tolérant, validation stricte des
réponses par jour, respect de la charge autorisée, reports, scissions), le moteur de capacité (estimation de taille, plan de charge 1-3-5), le check-in (réduction de
charge selon l'état) et le nettoyage guidé (fantômes, doublons, orphelines).

## Déploiement sur Orkestr

Orkestr construit une image Docker à partir du dépôt. Le `Dockerfile` fourni est utilisé
tel quel ; l'application écoute sur `0.0.0.0:$PORT`.

1. **Pousser le code** sur GitHub, GitLab, Bitbucket ou Codeberg. Un dépôt **public** est
   cloné directement ; un dépôt privé nécessite une connexion au fournisseur Git.
2. (Dépôt privé uniquement) Dans Orkestr, **Settings → Connected Providers** : connecter
   le fournisseur Git.
3. **Projects → New Project** : choisir le dépôt et la branche (`main`).
   Orkestr détecte Node/Express et le port. Le plan gratuit suffit (1 projet,
   1 environnement).
4. Ouvrir l'environnement **production**, puis **Environment Variables** et ajouter :
   - `TODOIST_API_TOKEN`
   - `APP_PASSWORD`
   - `SESSION_SECRET`
   - `APP_TIMEZONE` = `Europe/Zurich` (l'instance en ligne utilise `Europe/Zurich` ; le
     défaut du code reste `Europe/Paris`)
   Ne pas définir `TODOIST_BASE_URL`.
5. Cliquer **Deploy** et suivre les logs jusqu'au statut **Live**.
6. L'application est disponible sur `https://<slug>.orkestr.run`.
   L'URL `/healthz` doit répondre `{"ok":true,...}`.

Toute modification d'une variable d'environnement nécessite un nouveau déploiement.

> **Auto-déploiement.** Le redéploiement automatique à chaque `git push` n'est actif que
> si le dépôt est relié à Orkestr via l'application GitHub (qui installe aussi le webhook
> signé). Sinon, après un `git push`, lancer un déploiement depuis la console Orkestr
> (**Deploy**) ou via l'API :
>
> ```bash
> curl -X POST \
>   "https://api.orkestr.eu/api/v1/projects/<project_id>/deployments?environment_id=<env_id>" \
>   -H "Authorization: Bearer <ork_token>"
> ```

## Vérification sur téléphone (itérations 1 à 4)

1. Ouvrir `https://<slug>.orkestr.run` : la page de connexion s'affiche.
2. Entrer un mauvais mot de passe : le message « Mot de passe incorrect. » apparaît.
3. Entrer le bon mot de passe : le tableau de bord « Ton Todoist, en clair. » s'affiche.
4. Vérifier que le nombre de projets et de tâches correspond à ton compte Todoist.
5. Dans **Planifier par jour**, la bande **« Charge par jour »** s'affiche en haut, et le
   jour du jour est présélectionné.
6. Ouvrir le **check-in** « Comment te sens-tu ? », choisir par exemple **Malade** +
   **Épuisé** + **Moins d'1 h**, puis **Adapter ma journée** : l'objectif du jour baisse
   (ex. « 0 gros · 0 moyens · 3 petits ») et l'IA propose surtout de **reporter** des tâches.
7. Valider un report ou un ajout : la place du jour se met à jour, **les autres cartes
   restent**.
8. Cliquer un autre jour : les propositions sont différentes et adaptées (et le check-in y
   est indépendant).
7. Vérifier dans l'app Todoist que la modification est bien là.
8. Dans **Diagnostic des projets**, vérifier le classement et les filtres.
9. Ouvrir un projet dans **Explorer** : sections et sous-tâches apparaissent.
10. Appuyer sur **Exporter** : le fichier `todoist-export-….json` contient aussi les
    propositions et le diagnostic.
11. Se déconnecter : retour à la page de connexion.

> Astuce : pour tester sans risque, mets `WRITES_ENABLED=false` : l'app reste entièrement
> fonctionnelle mais refuse toute écriture.

## Structure

```
server.js              démarrage HTTP
src/app.js             routes Express, sécurité, gestion d'erreurs
src/auth.js            mot de passe + cookie de session signé
src/config.js          lecture des variables d'environnement
src/todoist.js         client API Todoist (lectures + écritures, retries, erreurs typées)
src/snapshot.js        normalisation, statistiques, dates dérivées
src/diagnosis.js       verdicts, signaux et propositions par projet
src/capacity.js        estimation de taille et plan de charge 1-3-5
src/checkin.js         questionnaire du jour et charge autorisée
src/recycleBin.js      corbeille des tâches supprimées (restauration)
src/proposals.js       génération des propositions (pure)
src/applyProposal.js   exécution d'une proposition + vérification via l'API
src/ai.js              client OpenRouter (appel au modèle)
src/aiProposals.js     condensé, invite, validation et cache des propositions IA
src/exportService.js   orchestration + cache mémoire
src/dates.js           analyse des conventions de date
views/                 pages HTML (connexion, tableau de bord)
public/                CSS, JS, manifest PWA, icônes et service worker
test/                  tests unitaires (node:test)
```

## Sécurité

- Mot de passe comparé à temps constant ; 10 tentatives max par IP et par tranche de
  15 minutes.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` derrière HTTPS.
- Vérification d'origine et en-tête `X-App-Request: 1` sur les requêtes sensibles.
- En-têtes CSP stricts, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- Écritures Todoist **uniquement** après validation individuelle d'une proposition
  présente dans l'instantané courant ; chaque écriture est relue pour vérification.
  Aucun secret dans le dépôt.

## Périmètre

Itérations 1 à 9 terminées : export, lecture, diagnostic des projets, planification
**jour par jour** assistée par une IA, **check-in du jour**, scission des tâches,
**nettoyage guidé** avec corbeille et **confort d'usage** (tout valider, PWA installable,
récap hebdo). Les itérations suivantes (rituel du matin avec rattrapage automatique,
planificateur de semaine, reformulation des titres, mémoire des préférences) ne sont pas
implémentées et seront abordées après retour d'usage.
