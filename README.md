# BacRush — Petit Bac multijoueur, 15 manches, arbitrage par IA

BacRush est un jeu de Petit Bac en ligne : un salon, **jusqu'à 8 joueurs**,
15 manches. Le serveur est la seule source de vérité — il tire les lettres,
tient le chronomètre, enregistre les réponses, décide de la clôture, fait
vérifier chaque mot par l'IA et applique le barème. Le navigateur se contente
d'afficher et d'envoyer des intentions.

## Démarrer

```bash
npm install
cp .env.example .env     # puis coller la clé dans .env
npm start
```

`npm start` lit automatiquement le fichier `.env` s'il existe. Ce fichier est
ignoré par git : la clé n'arrive jamais sur GitHub.

### Où trouver la clé d'API

1. Aller sur [console.anthropic.com](https://console.anthropic.com) et se
   connecter (compte séparé d'un abonnement Claude.ai : l'API se paie à
   l'usage, il faut créditer le compte dans **Billing**).
2. **Settings → API keys → Create Key**.
3. Copier la clé (`sk-ant-...`) — elle n'est affichée qu'une seule fois.
4. La coller dans `.env` en local, et dans l'interface de l'hébergeur en ligne
   (jamais dans le dépôt).

Au démarrage, le serveur affiche `IA active (claude-opus-5)` ou
`IA inactive — ANTHROPIC_API_KEY absente, mode secours`, et l'accueil du jeu
indique la même chose aux joueurs.

**Ce que ça coûte** : une manche = un appel (plus un second si des réponses
restent douteuses). Avec 8 joueurs et `claude-opus-5`, compter quelques
dizaines de centimes par manche, soit l'ordre de quelques euros pour une
partie de 15 manches ; nettement moins à 2 ou 3 joueurs. Pour diviser la note,
basculer sur un modèle moins cher :

```bash
BACRUSH_AI_MODEL=claude-sonnet-5
```

Le démarrage affiche deux adresses :

```
Sur cet ordinateur : http://localhost:3000
Depuis un téléphone (en0) : http://192.168.1.x:3000
```

Un joueur crée la partie et partage le code à 4 caractères ; les autres le
saisissent depuis leur propre appareil. En local, tout le monde doit être sur
le même réseau Wi-Fi — pour jouer avec des gens ailleurs, voir
**Jouer en ligne** ci-dessous.

Sans `ANTHROPIC_API_KEY`, le jeu fonctionne en **mode secours** : l'interface
l'indique clairement et la validation s'appuie sur des lexiques et des règles
locales, bien plus limitées que l'IA. Le vote du salon (ci-dessous) prend alors
le relais : les joueurs arbitrent eux-mêmes ce que le serveur ne sait pas
trancher, et le jeu reste parfaitement jouable sans rien payer.

## Jouer en ligne (déploiement)

En local, le serveur n'est joignable que sur ton réseau. Pour que des joueurs
d'ailleurs rejoignent un salon, il faut l'héberger. Le dépôt contient tout le
nécessaire : un `Dockerfile` et un blueprint `render.yaml`.

**Sur Render (gratuit, le plus direct)**

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**
2. Choisir le dépôt `bacrush` — Render lit `render.yaml` tout seul
3. Quand il demande `ANTHROPIC_API_KEY`, coller la clé (c'est le seul secret ;
   sans elle le jeu tourne en mode secours et le dit aux joueurs)
4. **Apply** → au bout de quelques minutes, une adresse du type
   `https://bacrush.onrender.com` : c'est elle qu'on partage

Le plan gratuit endort le service après 15 minutes sans trafic : le premier
chargement au réveil est lent et **les parties en cours sont perdues**. Pour
des soirées régulières, passer `plan: free` à `plan: starter` dans
`render.yaml` (service toujours allumé).

**Ailleurs** — le `Dockerfile` fonctionne tel quel sur Fly.io, Railway, Koyeb
ou n'importe quel hébergeur Docker. Une seule contrainte, quel que soit
l'hôte : **un seul exemplaire**. Les parties vivent dans la mémoire du
processus ; deux exemplaires enverraient les joueurs d'un même salon sur des
serveurs différents, avec des lettres et des scores distincts.

## Règles appliquées

| Règle | Mise en œuvre |
|---|---|
| Salon de 2 à 8 joueurs | capacité vérifiée côté serveur (`MAX_PLAYERS`), 9ᵉ joueur refusé |
| 8 rubriques fixes | `src/shared/categories.js` |
| 15 manches, 15 lettres distinctes | tirage unique par partie (`src/game/letters.js`), 20 lettres éligibles (K, Q, W, X, Y, Z écartées) |
| 240 s par manche | horloge serveur (`src/game/room.js`), le navigateur n'affiche qu'un décompte dérivé |
| Bouton FIN | invisible tant que les 8 rubriques ne sont pas remplies, revérifié côté serveur |
| Clôture globale | un seul clic accepté, la manche se termine pour tout le monde |
| Fin automatique à 00:00 | balayage serveur toutes les 250 ms, sans dépendre d'un navigateur ouvert |
| Vote du salon | 60 s de contestation avant le comptage, majorité des autres joueurs |
| Barème 2 / 1 / 0 | `src/game/scoring.js`, appliqué après le vote, jamais par l'IA |

## Le vote du salon (arbitrage humain)

Après la validation et **avant que le moindre point ne soit attribué**, le
salon dispose de 60 secondes pour contester. Chaque joueur voit les réponses de
tous, avec leur statut provisoire, et peut toucher « Contester » sur celles des
autres — jamais sur les siennes, ni sur une réponse déjà à zéro.

Une réponse est refusée si **la majorité stricte des autres joueurs** la
conteste : 2 voix sur 2 autres joueurs, 2 sur 3, 4 sur 7. Sinon le verdict
initial tient. Le vote se termine dès que tout le monde a appuyé sur « Prêt »,
ou seul à la fin du compte à rebours — un joueur parti ne bloque personne.

C'est ce qui rend le jeu **jouable sans clé d'API** : le mode secours valide ce
qu'il reconnaît, et les joueurs tranchent le reste entre eux, comme à la vraie
table. En solo, il n'y a pas de vote : les points s'appliquent directement.

## Comment l'IA valide (le cœur du jeu)

1. **Constitution du lot** — les réponses vides ne partent pas à l'IA (elles
   valent 0). Chaque réponse reçoit un identifiant opaque (`r1`, `r2`, …) :
   l'identité des joueurs n'est jamais transmise au modèle, ce qui évite tout
   biais entre participants.
2. **Premier examen** (`src/ai/anthropic-validator.js`) — un appel au modèle
   `claude-opus-5` avec un outil à schéma strict : pour chaque réponse, le mot
   réellement voulu, sa première lettre, une clé canonique d'entité, un statut
   (`valide` / `invalide` / `a_verifier`), un motif, un niveau de confiance.
3. **Vérification documentaire** — seules les réponses restées incertaines
   repartent dans un second appel, cette fois avec l'outil de recherche web
   exécuté côté Anthropic. Une recherche infructueuse ne refuse pas la réponse :
   elle reste « à vérifier ».
4. **Contrôle serveur** (`src/ai/schema.js`) — les identifiants inventés sont
   ignorés, les champs bornés, les statuts inconnus ramenés à « à vérifier », et
   toute réponse oubliée par le modèle reçoit un verdict par défaut. Les
   verdicts sont ensuite réassociés à leur couple (joueur, rubrique).
5. **Règle de la lettre, revérifiée** (`src/game/scoring.js`) — le serveur
   contrôle lui-même la première lettre du mot reconnu *et* du texte saisi.
   Même si l'IA validait « Paris » pour la lettre M, la réponse vaut 0.
6. **Regroupement** — uniquement entre réponses retenues, dans la même rubrique
   et la même manche, sur la clé canonique de l'IA ou l'égalité exacte. Aucune
   fusion « par ressemblance » : *Marie* et *Maria* restent deux réponses.
7. **Barème** — groupe d'un seul joueur : 2 points ; groupe partagé : 1 point
   chacun ; vide, invalide ou mauvaise lettre : 0. Les points d'une manche ne
   peuvent être attribués qu'une seule fois.

### Si l'IA est indisponible

Aucune validation globale n'est appliquée. Le validateur de secours
(`src/ai/fallback-validator.js`) accepte ce qu'il reconnaît vraiment, refuse ce
qui relève manifestement d'une autre rubrique (« Mouton » en Métier) ou de la
mauvaise lettre, et marque le reste « à vérifier ». Ces cas incertains sont
comptés mais signalés dans les résultats (`BACRUSH_UNCERTAIN_POLICY=strict`
pour les refuser). Une échéance globale garantit qu'une manche ne reste jamais
bloquée en attente du modèle.

## Architecture

```
src/
  server.js              HTTP + SSE + fichiers statiques, aucune clé exposée
  shared/categories.js   les 8 rubriques et leurs règles
  shared/normalize.js    normalisation, distance d'édition, première lettre
  game/letters.js        tirage des 15 lettres distinctes
  game/room.js           machine d'état d'une partie (chrono, clôture, vote, scores)
  game/hub.js            salles, balayage temporel, déclenchement de validation
  game/scoring.js        regroupement + barème fixe
  ai/prompt.js           consignes d'arbitrage et mise en forme du lot
  ai/schema.js           schéma de sortie + contrôle serveur des verdicts
  ai/anthropic-validator.js  appels réels (SDK officiel), 2 passes
  ai/fallback-validator.js   validation hors ligne
  ai/validator.js        orchestration, échéances, bascule de secours
public/                  interface (HTML/CSS/JS, sans build)
tests/                   66 tests
```

Transport : SSE (`GET /api/stream`) pour les états poussés par le serveur,
`POST /api/rooms/...` pour les actions. Pas de dépendance de transport ; la
seule dépendance du projet est le SDK Anthropic officiel.

## Sur téléphone

L'interface est pensée pour être jouée au pouce :

- une seule colonne, champs hauts et espacés, texte à 16 px (pas de zoom iOS) ;
- barre collante en haut : manche, salle, **lettre** et chronomètre restent
  visibles pendant le défilement des 8 rubriques ;
- bouton FIN pleine largeur ancré en bas, au-dessus d'un dégradé, avec marge de
  sécurité pour les écrans à encoche ;
- clavier adapté (`enterkeyhint`, majuscule automatique, correction désactivée) ;
  la touche Entrée passe à la rubrique suivante, puis déclenche FIN ;
- aucun défilement horizontal, y compris sur le tableau du classement final
  (il défile dans son propre conteneur).

## Tests

```bash
npm test          # 77 tests, sans réseau ni clé d'API
npm run test:ai   # ajoute les tests de l'IA réelle (nécessite ANTHROPIC_API_KEY)
```

`tests/anthropic-request.test.js` fait dialoguer le vrai SDK avec une API
factice pour vérifier la forme exacte des requêtes (outil strict, choix d'outil
forcé, outil de recherche, reprise après `pause_turn`) sans consommer de jetons.

## Limites connues

- L'état des parties vit en mémoire : un redémarrage du serveur efface les
  parties en cours, et l'hébergement doit rester sur un seul exemplaire.
- Le mode secours est volontairement modeste ; il ne remplace pas l'IA.
- Les salons sont ouverts à qui connaît le code (jeu entre amis, réseau de
  confiance).
