# BacRush — Petit Bac multijoueur, 6 à 18 manches, arbitrage par IA

BacRush est un jeu de Petit Bac en ligne : un salon, **jusqu'à 10 joueurs**,
**6, 12 ou 18 manches** au choix. Le serveur est la seule source de vérité — il tire les lettres,
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
restent douteuses). Avec un salon plein et `claude-opus-5`, compter quelques
dizaines de centimes par manche, soit l'ordre de quelques euros pour une
partie complète ; nettement moins à 2 ou 3 joueurs. Pour diviser la note,
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
nécessaire : un `Dockerfile`, un blueprint `render.yaml` et une config
`railway.json`.

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

**Sur Railway** — `railway.json` est prêt (même image Docker que Render).

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Choisir `bacrush` : Railway lit `railway.json` et construit le `Dockerfile`
3. Onglet **Variables** → ajouter `ANTHROPIC_API_KEY` si tu veux l'arbitrage IA
   (facultatif : sans elle, le mode secours et le vote du salon suffisent)
4. Onglet **Settings → Networking** → **Generate Domain** : c'est l'adresse à
   partager

Railway injecte `PORT` tout seul, le serveur l'utilise. Ne monte **jamais** le
nombre de réplicas au-dessus de 1 (`numReplicas` dans `railway.json`).

**Ailleurs** — le `Dockerfile` fonctionne tel quel sur Fly.io, Koyeb ou
n'importe quel hébergeur Docker. Une seule contrainte, quel que soit l'hôte :
**un seul exemplaire**. Les parties vivent dans la mémoire du processus ; deux
exemplaires enverraient les joueurs d'un même salon sur des serveurs
différents, avec des lettres et des scores distincts.

## Règles appliquées

| Règle | Mise en œuvre |
|---|---|
| Salon de 1 à 10 joueurs | capacité vérifiée côté serveur (`MAX_PLAYERS`), joueur suivant refusé |
| Longueur de partie | 6, 12 ou 18 manches, choisie par l'hôte dans le salon |
| Quitter en cours de route | le joueur disparaît du salon et du barème ; si l'hôte part, un autre prend sa place |
| 8 rubriques fixes | `src/shared/categories.js` |
| Lettres toutes distinctes | roulette alimentée par les lettres encore disponibles (`src/game/letters.js`), 20 éligibles (K, Q, W, X, Y, Z écartées) |
| 240 s par manche | horloge serveur (`src/game/room.js`), le navigateur n'affiche qu'un décompte dérivé |
| Bouton FIN | invisible tant que les 8 rubriques ne sont pas remplies, revérifié côté serveur |
| Clôture globale | un seul clic accepté, la manche se termine pour tout le monde |
| Fin automatique à 00:00 | balayage serveur toutes les 250 ms, sans dépendre d'un navigateur ouvert |
| Arbitrage humain | vote du salon (60 s), notation libre (90 s) ou arbitre désigné (2 min), au choix de l'hôte |
| Barème 2 / 1 / 0 | `src/game/scoring.js`, appliqué après le vote, jamais par l'IA |

## La roulette des lettres

La lettre n'est plus tirée en silence : au début de chaque manche, une roulette
fait défiler les lettres encore disponibles et **l'hôte appuie sur STOP**. La
lettre retenue est celle qui passait à cet instant précis.

Le défilement se calcule à partir de l'horloge du serveur, avec la même formule
des deux côtés : tous les écrans affichent la même lettre au même instant, et
le serveur recalcule l'arrêt lui-même. Personne ne peut contester ce qu'il a
vu, personne ne peut forcer une lettre.

La roue ne contient que les lettres non encore sorties : deux manches ne
peuvent pas tomber sur la même, par construction. Sans appui, la roulette
s'arrête seule au bout de 15 secondes ; si l'hôte a fermé son onglet, un autre
joueur peut appuyer. Le chronomètre de la manche ne démarre qu'une fois la
lettre fixée.

## L'arbitrage humain

Après la validation automatique et **avant que le moindre point ne soit
attribué**, les joueurs ont le dernier mot. L'hôte choisit la formule dans le
salon, avant le lancement ; elle vaut pour toute la partie.

Chaque phase de correction dure **au moins deux minutes** — 2 min pour le vote,
2 min 30 pour la notation libre, 3 min pour l'arbitre, qui relit tout le monde.
L'hôte n'est jamais obligé d'attendre la fin : le bouton
**« Tout est corrigé — manche suivante »** clôt les corrections dès que le
salon est d'accord. C'est aussi lui qui lance la manche suivante depuis l'écran
des résultats ; si son onglet est fermé, n'importe quel joueur peut prendre le
relais pour que la partie ne reste pas en plan.

**Le salon vote** (par défaut) — 60 secondes pour toucher « Contester » sur les
réponses des autres, jamais sur les siennes ni sur une réponse déjà à zéro. Une
réponse tombe si **la majorité stricte des autres joueurs** la conteste : 2
voix sur 2 autres joueurs, 2 sur 3, 4 sur 7. Le vote se clôt dès que tout le
monde a appuyé sur « Prêt ».

**Chacun se note** — chaque joueur s'attribue lui-même 0, 1 ou 2 sur chacune
de ses réponses, comme à la maison. Les réponses de tout le monde sont
affichées pour décider entre 1 et 2, et le calcul automatique est proposé par
défaut : il suffit de le confirmer. 90 secondes, puis « J'ai fini ».

**Un arbitre** — l'hôte désigne un joueur. Il joue normalement et marque des
points, mais c'est lui seul qui tranche : ✓ pour repêcher une réponse que la
machine n'a pas su valider, ✕ pour en refuser une. Il dispose de 2 minutes, et
juge aussi ses propres réponses. Sans décision de sa part, le verdict
automatique s'applique. S'il quitte le salon, la partie repasse au vote.

Une limite vaut pour le vote et l'arbitre : **personne ne peut repêcher une
réponse qui ne commence pas par la lettre imposée**. Cette règle appartient au
serveur. La notation libre, elle, fait confiance aux joueurs de bout en bout —
c'est son principe.

Les trois formules se terminent seules à la fin du compte à rebours, et un
joueur déconnecté ne bloque personne. En solo, les points s'appliquent
directement.

C'est ce qui rend le jeu **jouable sans clé d'API** : le mode secours valide ce
qu'il reconnaît, les joueurs tranchent le reste, comme à la vraie table.

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
npm test          # 136 tests, sans réseau ni clé d'API
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
