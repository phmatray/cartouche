// Traduction française de legal.ts (la version anglaise fait foi). Mêmes sections, mêmes adresses.
import type { LegalSection } from './legal';

export const LEGAL_FR: LegalSection[] = [
  {
    title: 'Avertissement',
    body:
      'Cartouche est un émulateur indépendant et open source pour les jeux Game Boy et Game Boy Color. ' +
      'Il n’est ni affilié à Nintendo, ni parrainé ni approuvé par Nintendo. Game Boy, Game Boy Color ' +
      'et Nintendo sont des marques de Nintendo. Les titres de jeux sont des marques de leurs propriétaires ' +
      'respectifs et ne sont utilisés que pour identifier les jeux.\n\n' +
      'Cartouche est fourni « en l’état », sans garantie d’aucune sorte, sous licence MIT. Il appartient à ' +
      'chacun de s’assurer d’avoir le droit d’utiliser les fichiers qu’il charge.',
  },
  {
    title: 'Ce que contient Cartouche',
    body:
      'Un émulateur qui ne contient aucun code Nintendo ni aucune copie du logo Nintendo. Ses boot ROM sont celles ' +
      'de Cartouche, modifiées d’après les boot ROM open source de SameBoy, © 2015-2026 Lior Halphon, licence MIT ' +
      '(https://github.com/LIJI32/SameBoy) : du code original, pas celui de Nintendo. Elles ne lisent, n’affichent ' +
      'et ne vérifient jamais le logo enregistré dans une cartouche. L’animation de démarrage (Réglages > Émulation : ' +
      'Repérage, Insertion ou Étagère) est un dessin et un carillon propres à Cartouche, sans aucun logo ; désactivée, ' +
      'les jeux démarrent directement dans l’état documenté qui suit le démarrage. Les couleurs Game Boy Color d’un ' +
      'jeu Game Boy d’origine, si vous les choisissez, sont calculées par la boot ROM sans être affichées. Les cadres et couleurs Super Game Boy ' +
      'sont dessinés à partir des données envoyées par chaque jeu ; aucun logiciel Super Game Boy ou SNES n’est inclus.\n\n' +
      'Trois jeux homebrew gratuits, redistribués sans modification à partir des versions officielles de leurs auteurs :\n\n' +
      'Tobu Tobu Girl et Tobu Tobu Girl Deluxe, © 2017 Tangram Games (sources : ' +
      'https://github.com/SimonLarsen/tobutobugirl et https://github.com/SimonLarsen/tobutobugirl-dx). ' +
      'Code sous licence MIT ; graphismes, textes, sons et musique sous CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). Les fichiers publiés tobu.gb et tobudx.gb sont ' +
      'renommés tobutobugirl.gb et tobutobugirldx.gb. Leurs jaquettes sont les illustrations officielles de Tangram ' +
      'Games tirées de leurs pages itch.io (https://tangramgames.itch.io/tobutobugirl et ' +
      'https://tangramgames.itch.io/tobu-tobu-girl-deluxe), sous CC BY 4.0, recadrées au format carré et redimensionnées.\n\n' +
      'µCity 1.3, © 2017-2018 Antonio Niño Díaz, sous licence GNU GPL version 3 ou ultérieure (graphismes et ' +
      'musique sous CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/ ; son moteur GBT Player sous BSD 2-Clause). Le texte complet de la GPL est lié ci-dessous ; le ' +
      'code source correspondant complet est l’étiquette v1.3 de l’auteur : https://github.com/AntonioND/ucity/tree/v1.3 ' +
      '(aussi https://codeberg.org/SkyLyrac/ucity/src/tag/v1.3, et joint à chaque version de Cartouche). ' +
      'µCity est un programme distinct que l’émulateur charge comme des données (simple agrégation) : sa licence ne ' +
      's’applique pas à Cartouche.\n\n' +
      'Trois cartouches de test, redistribuées sans modification : dmg-acid2 (v1.0) et cgb-acid2 (v1.1) de Matt ' +
      'Currie, licence MIT (https://github.com/mattcurrie/dmg-acid2, https://github.com/mattcurrie/cgb-acid2), ' +
      'et cpu_instrs de Blargg, par Shay Green, issu de https://github.com/retrio/gb-test-roms. Son auteur ' +
      'n’indique aucune licence ; il est inclus parce que la communauté de l’émulation le redistribue largement pour ' +
      'les tests, et il sera retiré immédiatement à la demande de l’auteur.\n\n' +
      'Quatre jeux créés avec GB Studio, hébergés sans modification parce que les licences de leurs auteurs ' +
      'autorisent la redistribution de la ROM entière : Dawn Will Come (code MIT, graphismes et musique CC BY 4.0), ' +
      'Poltersprite (jeu CC BY-NC-SA 4.0, code GPL-3.0), Millennium Gun (code 0BSD, graphismes et sons CC0 1.0, ' +
      'plugin MIT) et Dusky Dungeon (MIT, graphismes CC BY 4.0, polices CC BY 4.0 et CC BY 3.0). Chacun n’est ' +
      'téléchargé qu’à votre demande. Leurs auteurs, sources et conditions de licence complètes figurent dans ' +
      'roms/gbstudio/LICENSES.txt, lié ci-dessous. Les autres jeux de la collection GB Studio ne sont pas hébergés : ' +
      'ils renvoient aux pages de leurs auteurs.\n\n' +
      'Une base de données de dumps Game Boy et Game Boy Color connus (empreintes de fichiers, titres et noms ' +
      'No-Intro), utilisée uniquement pour identifier les fichiers ajoutés. La bibliothèque liste des homebrews gratuits, des ' +
      'cartouches de test librement disponibles et les ROM personnelles, jamais de jeux commerciaux. Aucune image de jeu commercial.',
  },
  {
    title: 'Aucune ROM fournie',
    body:
      'Cartouche n’inclut pas, n’héberge pas, ne propose aucun lien vers des ROM de jeux commerciaux ni vers des fichiers ' +
      'BIOS et n’aide pas à en trouver, et ne liste aucun jeu commercial. Sa base de dumps connus ne fait que reconnaître un ' +
      'fichier chargé par l’utilisateur lui-même.\n\n' +
      'Ne jouez qu’aux jeux que vous possédez, avec des copies de sauvegarde que vous avez faites vous-même à partir de vos propres cartouches. La législation ' +
      'sur les copies de sauvegarde varie d’un pays à l’autre ; vérifiez celle qui s’applique à vous.',
  },
  {
    title: 'Jaquettes',
    body:
      'Les deux jeux Tobu Tobu Girl sont fournis avec leurs propres jaquettes (sous licence libre, voir ci-dessus) : ce sont ' +
      'des fichiers de cette app, affichés sans demande et sans contacter aucun autre site. Toutes les autres ' +
      'jaquettes sont désactivées par défaut et ne sont jamais hébergées ni redistribuées par Cartouche. Ces images appartiennent ' +
      'aux éditeurs des jeux et aux autres titulaires de droits. Au premier lancement, une boîte de dialogue demande « Afficher les jaquettes ? ». ' +
      'Seulement si « Télécharger les jaquettes » est choisi (ou si les jaquettes sont activées plus tard dans Réglages > Stockage, avec accord), ' +
      'le navigateur télécharge la jaquette de chaque ROM reconnue ajoutée, directement depuis le ' +
      'projet libretro-thumbnails sur GitHub (https://github.com/libretro-thumbnails, servi depuis ' +
      'raw.githubusercontent.com), et la conserve dans le stockage de ce navigateur (Cache Storage). La réponse ' +
      'et sa date sont enregistrées dans les réglages, et la restauration d’une copie de sauvegarde ne les modifie jamais. La question ' +
      'n’est reposée que si les jaquettes sont activées après un refus, ou après « Tout effacer ». Avec ' +
      '« Continuer sans » (ou Esc), l’app ne fait aucune requête à libretro-thumbnails. ' +
      'Réglages > Stockage indique l’espace utilisé par les jaquettes, les supprime (« Supprimer les jaquettes téléchargées », ' +
      'qui désactive aussi les jaquettes) et les télécharge à nouveau pour la bibliothèque.\n\n' +
      'Jeux GB Studio. Les quatre que Cartouche héberge affichent leur propre écran titre comme jaquette, des fichiers de ' +
      'cette app sous les licences de leurs graphismes (voir roms/gbstudio/LICENSES.txt). Pour tous les autres, seule ' +
      'l’adresse de l’image de couverture de la page itch.io de l’auteur est conservée. Si les jaquettes sont autorisées, ' +
      'le navigateur charge cette image directement depuis itch.io (img.itch.zone), qui reçoit l’adresse IP et les ' +
      'informations du navigateur (https://itch.io/docs/legal/privacy-policy), et la garde seulement dans son cache ordinaire. Jaquettes ' +
      'désactivées, aucune requête n’est envoyée à itch.io.',
  },
  {
    title: 'Métadonnées des jeux',
    body:
      'Les titres, développeurs, dates de sortie et genres proviennent de GameDataBase © 2024 par PigSaint ' +
      '(https://github.com/PigSaint/GameDataBase), sous licence CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). Les noms No-Intro proviennent de libretro-database ' +
      '(https://github.com/libretro/libretro-database), sous licence CC BY-SA 4.0 ' +
      '(https://creativecommons.org/licenses/by-sa/4.0/). Modifications : Cartouche conserve une partie des ' +
      'colonnes, relie les deux par empreinte de fichier et publie le fichier combiné (gamedb.json) sous ' +
      'CC BY-SA 4.0. Aucun des deux projets ne cautionne Cartouche.',
  },
  {
    title: 'Confidentialité',
    body:
      'Pas de compte, pas de serveur, pas de statistiques, pas de publicité, pas de cookies.\n\n' +
      'Les ROM, sauvegardes, sauvegardes instantanées, réglages, favoris et temps de jeu sont stockés uniquement dans ce ' +
      'navigateur (IndexedDB et localStorage) et ne quittent jamais l’appareil, sauf si la synchronisation entre appareils est activée (voir plus bas). Effacer les données de ce site dans ' +
      'les réglages du navigateur supprime tout.\n\n' +
      'Seul GitHub reçoit des requêtes, sauf si les jaquettes sont autorisées, en cas de connexion à RetroAchievements, de jeu en ligne ou de synchronisation entre appareils (voir plus bas). GitHub Pages sert l’app et ses polices. Les jaquettes sont désactivées par ' +
      'défaut et nécessitent un accord (boîte de dialogue du premier lancement ou Réglages > Stockage) ; seulement alors le ' +
      'navigateur charge aussi les jaquettes des ROM reconnues ajoutées depuis raw.githubusercontent.com, et celles des jeux GB Studio depuis itch.io (img.itch.zone, voir Jaquettes). Comme tout ' +
      'serveur web, GitHub reçoit ' +
      'l’adresse IP et les informations du navigateur ; voir la déclaration générale de confidentialité de GitHub ' +
      '(https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).\n\n' +
      'Les jaquettes téléchargées sont conservées dans ce navigateur (Cache Storage) et ne sont jamais envoyées nulle part. Elles peuvent être supprimées à tout moment avec ' +
      '« Supprimer les jaquettes téléchargées » dans Réglages > Stockage, ou en effaçant les données du site.\n\n' +
      'RetroAchievements reste désactivé tant qu’aucun compte n’est connecté dans Réglages > Succès, avec un nom d’utilisateur et une ' +
      'clé d’API web (jamais le mot de passe). Les deux restent dans ce navigateur (localStorage). Une fois connecté, le navigateur ' +
      'demande à retroachievements.org (https://retroachievements.org) la liste des jeux des deux consoles et, pour un jeu ouvert, ' +
      'ses succès et ceux déjà obtenus ; la clé et le nom d’utilisateur figurent dans ces requêtes, comme l’exige son API web. ' +
      'Une ROM est reconnue en comparant son empreinte MD5 à ces listes dans le navigateur : ni la ROM ni son empreinte ne sont ' +
      'envoyées. RetroAchievements reçoit l’adresse IP et les informations du navigateur. « Déconnecter » oublie la clé et arrête toute requête.\n\n' +
      'Le jeu en ligne (Câble Link) et la synchronisation entre appareils (Réglages > Synchro) n’envoient aucune requête ' +
      'tant qu’aucun salon n’est ouvert ou rejoint et qu’aucun appareil n’est associé. Ensuite, le navigateur contacte ' +
      'cinq relais Nostr publics que Cartouche n’exploite pas (relay02.lnfi.network, staging.yabu.me, top.testrelay.top, ' +
      'yabu.me et relay.mostro.network) pour trouver l’autre navigateur, et des serveurs STUN publics de Google et ' +
      'Cloudflare pour connaître sa propre adresse réseau. Les relais ne transmettent qu’une prise de contact chiffrée, ' +
      'mais ils voient les adresses IP des deux navigateurs, et l’autre joueur ou appareil apprend la vôtre : c’est le ' +
      'principe d’une connexion directe (WebRTC). Les données de jeu et de synchronisation passent ensuite directement ' +
      'd’un navigateur à l’autre, chiffrées, sans aucun serveur de Cartouche. Si vous ajoutez votre propre serveur TURN ' +
      '(Jouer en ligne > réglages de connexion), une connexion qui ne peut pas être directe passe par lui.',
  },
  {
    title: 'Demandes de retrait',
    body:
      'Si quelque chose dans Cartouche semble porter atteinte à vos droits, ouvrez un ticket « Takedown request » ' +
      'sur https://github.com/phmatray/cartouche/issues/new/choose (les tickets sont publics). Pour une ' +
      'demande non publique, utilisez la procédure DMCA de GitHub ' +
      '(https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) ; le ' +
      'projet n’a pas d’adresse e-mail privée.\n\n' +
      'Le mainteneur s’efforce de répondre sous 72 heures. Un contenu plausiblement contrefaisant est ' +
      'd’abord désactivé, puis examiné.',
  },
  {
    title: 'Open source',
    body:
      'Code source : https://github.com/phmatray/cartouche (licence MIT). Les textes de licence ci-dessous ' +
      'sont publiés avec l’app, et THIRD_PARTY_NOTICES.md dans le dépôt contient les mêmes mentions.',
    links: [
      { file: 'LICENSE.txt', label: 'Licence de Cartouche (MIT)' },
      { file: 'THIRD_PARTY_NOTICES.txt', label: 'Mentions de tiers (jeux et cartouches de test inclus, GameDataBase, polices, jaquettes)' },
      { file: 'licenses/GPL-3.0-ucity.txt', label: 'GNU GPL version 3 (µCity)' },
      { file: 'roms/gbstudio/LICENSES.txt', label: 'Collection GB Studio : auteurs et licences des jeux hébergés' },
      { file: 'THIRD_PARTY_LICENSES.txt', label: 'Licences complètes des paquets npm, crates Rust et polices inclus' },
    ],
  },
];
