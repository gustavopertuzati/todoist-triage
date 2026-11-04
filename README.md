# Triage pour Todoist

Petite application web personnelle, pensée d'abord pour le téléphone, qui lit un compte
Todoist surchargé et aide à y voir clair.

**En ligne :** <https://todoist-triage.orkestr.run> (instance configurée sur
`Europe/Zurich`). Code : <https://github.com/gustavopertuzati/todoist-triage>.

> **Itérations 1 à 5.** L'app affiche un résumé, explore les projets, **diagnostique
> chaque projet**, et **propose des modifications concrètes** (donner une échéance,
> reporter, scinder, archiver) que tu **valides une par une**. À partir de l'itération 4,
> une **IA** (OpenRouter, `deepseek/deepseek-v4.1-flash`) réfléchit aux meilleures
> échéances ; depuis l'itération 5 elle tient compte de la **charge déjà posée chaque
> jour** et respecte une **capacité 1-3-5** (1 gros · 3 moyens · 5 petits par jour), et
> peut **scinder** les grosses tâches. Tant que tu n'as pas validé une proposition,
> **rien n'est écrit dans Todoist** ; chaque écriture validée est ensuite relue depuis
> l'API.
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
- **Propositions validables une par une** : l'app génère une liste d'actions concrètes
  ciblant des tâches ou des projets ; chaque carte se valide (ou s'ignore) individuellement,
  puis l'écriture est vérifiée via l'API. Voir « Itération 3 » ci-dessous.
- **Échéances proposées par une IA** : un modèle réfléchit à la meilleure date pour chaque
  tâche (répartition, priorités, regroupement par thème) et justifie son choix, au lieu
  d'appliquer une règle uniforme. Voir « Itération 4 » ci-dessous.
- **Capacité journalière 1-3-5** : l'app mesure la charge déjà posée chaque jour (à partir
  des échéances existantes) et n'accepte de nouvelles tâches que s'il reste de la place
  (1 grosse · 3 moyennes · 5 petites). L'IA peut aussi **scinder** une grosse tâche en
  sous-tâches concrètes. Voir « Itération 5 » ci-dessous.
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

## Itération 4 — échéances proposées par une IA

Quand `OPENROUTER_API_KEY` est défini, l'app envoie au modèle un condensé des tâches à
planifier (tâches en retard et anciennes sans échéance) et lui demande de choisir les
meilleures échéances. Le modèle répond uniquement par un JSON :

```json
{
  "summary": "Je regroupe maison/courses en fin de semaine et j'étale les lectures.",
  "proposals": [
    { "task_id": "…", "due_date": "2026-11-07", "reason": "…", "group": "Maison" }
  ]
}
```

Garde-fous :

- L'IA ne peut produire **qu'une seule action** : fixer une échéance (`set_due_date`).
  Rien d'autre n'est accepté — pas de suppression, pas de création.
- Chaque proposition est **validée** contre l'instantané : tâche connue, date ISO valide
  dans l'horizon (`today … today + AI_HORIZON_DAYS`), pas de doublon. Le reste est écarté.
- Les échéances IA **remplacent** la règle « tout à la même date » ; les autres types
  (reporter, scinder, archiver) restent générés par les règles.
- Résultat **mis en cache** par empreinte des données : un rechargement sans changement ne
  rappelle pas le modèle (et le coût reste de l'ordre du millième de dollar).
- Aucune donnée sensible n'est envoyée : uniquement des titres, métadonnées et la date du
  jour — jamais le token Todoist ni le mot de passe.
- La génération est asynchrone : l'interface affiche « l'IA réfléchit… » puis les
  propositions, sans bloquer l'affichage.
- Sans clé (ou `AI_ENABLED=false`), l'app fonctionne exactement comme avant, en mode règles.

Implémentation : `src/ai.js` (client OpenRouter) et `src/aiProposals.js` (condensé,
invite, validation, cache).

### Le lot de propositions

L'IA propose un **lot** (5 par défaut, `AI_MAX_PROPOSALS`). Tu les **valides ou les
ignores une par une** : valider une proposition **n'invalide pas les autres** du lot.
Quand le lot est épuisé — ou via le bouton **« Nouvelles propositions »** — un **nouveau
lot** est préparé, sur d'autres tâches si possible.

Les propositions déjà présentées restent valables un moment (magasin en mémoire, 2 h,
indépendant du cache de lecture) : tu ne verras plus de « cette proposition n'est plus
d'actualité » parce qu'une autre a été validée.

## Itération 5 — capacité journalière 1-3-5

Le problème des itérations précédentes : l'IA proposait des dates sans savoir ce qui était
**déjà prévu** ces jours-là, et pouvait donc surcharger une journée.

Désormais :

1. L'app calcule un **plan de charge** des 14 prochains jours à partir des échéances
   existantes, en estimant la taille de chaque tâche (durée renseignée, sinon nombre de
   sous-tâches et longueur de la note) : **Gros (L) / Moyen (M) / Petit (S)**.
2. Une journée saine respecte la règle **1-3-5** : au plus **1 grosse, 3 moyennes et
   5 petites** tâches. Le tableau de charge (et l'interface) montre la place restante.
3. Le plan est envoyé à l'IA, qui choisit les jours **selon la place restante** et donne
   une **taille** à chaque proposition.
4. Le serveur **vérifie** chaque proposition : si un jour dépasserait sa capacité, la
   proposition est **écartée** (et signalée dans la stratégie).
5. L'IA peut en plus proposer de **scinder** une grosse tâche en 2 à 10 sous-tâches
   concrètes ; la note d'origine est conservée.

Une bande « Charge par jour — 1 gros · 3 moyens · 5 petits » affiche, pour chaque jour,
ce qui est déjà posé et ce qu'il reste.

Seuils configurables : `CAPACITY_HORIZON_DAYS`, `CAPACITY_MAX_LARGE`,
`CAPACITY_MAX_MEDIUM`, `CAPACITY_MAX_SMALL`. La scission IA se coupe avec
`AI_ALLOW_SPLITS=false`.

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
| `AI_MAX_PROPOSALS` | non | `5` | Nombre maximum d'échéances proposées par l'IA (un « lot »). |
| `AI_HORIZON_DAYS` | non | `120` | Horizon maximum pour une échéance proposée. |
| `AI_TIMEOUT_MS` | non | `90000` | Délai maximal d'un appel au modèle. |
| `AI_CACHE_TTL_MINUTES` | non | `30` | Durée de cache des propositions IA. |
| `AI_ENABLED` | non | `true` | `false` désactive l'IA même si la clé est présente. |
| `CAPACITY_HORIZON_DAYS` | non | `14` | Nombre de jours couverts par le plan de charge. |
| `CAPACITY_MAX_LARGE` | non | `1` | Nombre maximum de grosses tâches par jour. |
| `CAPACITY_MAX_MEDIUM` | non | `3` | Nombre maximum de tâches moyennes par jour. |
| `CAPACITY_MAX_SMALL` | non | `5` | Nombre maximum de petites tâches par jour. |
| `AI_ALLOW_SPLITS` | non | `true` | Autorise l'IA à proposer de scinder une grosse tâche. |
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
réponses, respect de la capacité journalière, scissions, fusion avec les règles) et le
moteur de capacité (estimation de taille, plan de charge 1-3-5).

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
5. Dans **Propositions**, vérifier d'abord la bande **« Charge par jour »** : chaque jour
   affiche ce qui est déjà posé et ce qu'il reste. Puis attendre la ligne
   « 🧠 Stratégie : … » : les échéances proposées par l'IA apparaissent, avec un badge
   **IA**, une **taille** (Gros/Moyen/Petit), un **thème** et une justification. Vérifier
   qu'aucun jour n'est surchargé.
6. Valider une carte (changer la date si besoin) : un message confirme l'application, la
   carte disparaît et le compteur baisse. Une carte **Ignorer** disparaît durablement.
   La bande de charge se met à jour.
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
src/proposals.js       génération des propositions (pure)
src/applyProposal.js   exécution d'une proposition + vérification via l'API
src/ai.js              client OpenRouter (appel au modèle)
src/aiProposals.js     condensé, invite, validation et cache des propositions IA
src/exportService.js   orchestration + cache mémoire
src/dates.js           analyse des conventions de date
views/                 pages HTML (connexion, tableau de bord)
public/                CSS et JavaScript navigateur
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

Itérations 1 à 5 terminées : export, lecture, diagnostic des projets, propositions
validables individuellement (écritures vérifiées), échéances proposées par une IA et
planification respectant la capacité 1-3-5 des journées (avec scission des grosses
tâches). Les itérations suivantes (questionnaire quotidien avec sélection assistée,
rééquilibrage automatique d'une journée surchargée, propositions de suppression)
ne sont pas implémentées et seront abordées après retour d'usage.
