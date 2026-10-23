// Lexiques du MODE SECOURS uniquement (IA indisponible). Ils ne constituent
// jamais la liste des réponses acceptées : en fonctionnement normal, c'est le
// modèle qui juge le sens de chaque mot. Ici, un mot inconnu n'est pas refusé,
// il est marqué « à vérifier ».

export const LEXICONS = {
  prenom_fille: `Alice Amélie Anna Anne Aurélie Agathe Adèle Audrey Blanche Brigitte Bérénice Bérangère
    Camille Carole Céline Chloé Claire Clara Colette Daphné Delphine Diane Dominique Dorothée
    Élise Éléonore Emma Estelle Eva Élodie Fanny Fatima Flora Florence Françoise Gabrielle Garance
    Geneviève Gisèle Hélène Hortense Hélène Inès Irène Isabelle Ingrid Jade Jeanne Julie Juliette
    Josette Laure Léa Léonie Lucie Louise Lydia Manon Marie Maria Marion Mathilde Mélanie Monique
    Nadia Nathalie Nina Noémie Océane Olivia Ophélie Odette Pauline Perrine Prune Patricia Rachel
    Rose Roxane Régine Sarah Sophie Stéphanie Sylvie Simone Tatiana Thérèse Tiphaine Ursule Valérie
    Vanessa Véronique Violette Virginie`,

  prenom_garcon: `Adrien Alain Albert Antoine Arthur Alexandre Baptiste Benjamin Bernard Bruno Bastien
    Christophe Claude Clément Cyril César Daniel David Denis Didier Dimitri Édouard Émile Éric Étienne
    Fabien Félix Florian François Frédéric Gabriel Gaspard Georges Gérard Gilles Guillaume Hugo Henri
    Hervé Hubert Ismaël Ivan Isidore Jacques Jean Jérôme Jules Julien Lucas Louis Léon Loïc Laurent
    Marc Martin Mathieu Matthieu Maxime Michel Nicolas Noah Norbert Nathan Olivier Oscar Octave Pascal
    Patrick Paul Philippe Pierre Quentin Raphaël Rémi Robert Romain Richard Samuel Sébastien Simon
    Stéphane Thomas Théo Thierry Tristan Ulysse Valentin Victor Vincent`,

  ville: `Agen Ajaccio Amiens Angers Annecy Avignon Arras Albi Barcelone Bayonne Belfort Berlin Besançon
    Biarritz Bordeaux Boulogne Bourges Brest Bruxelles Caen Cannes Carcassonne Chambéry Chartres
    Cherbourg Colmar Chicago Dakar Dijon Douai Dunkerque Dublin Détroit Épinal Évreux Édimbourg
    Fréjus Fontainebleau Florence Francfort Gap Genève Grenoble Guingamp Gênes Hambourg Hyères
    Helsinki Istanbul Issoire Ivry Jérusalem Juvisy Jakarta Lens Lille Limoges Lisbonne Londres
    Lorient Lyon Madrid Marseille Metz Montauban Montpellier Moscou Mulhouse Milan Nancy Nantes
    Narbonne Nice Nîmes Niort Oslo Orléans Oyonnax Osaka Paris Pau Perpignan Poitiers Prague Rennes
    Reims Roanne Rome Rouen Royan Rodez Strasbourg Sète Séville Stockholm Toulon Toulouse Tours Troyes
    Tunis Tokyo Utrecht Ussel Uzès Valence Vannes Versailles Vienne Vichy Varsovie`,

  pays: `Afghanistan Albanie Algérie Allemagne Angola Argentine Australie Autriche Arménie Bangladesh
    Belgique Bénin Bolivie Brésil Bulgarie Birmanie Cambodge Cameroun Canada Chili Chine Colombie Congo
    Croatie Cuba Chypre Danemark Djibouti Dominique Égypte Équateur Espagne Estonie Éthiopie Érythrée
    Finlande France Fidji Gabon Ghana Grèce Guatemala Guinée Géorgie Haïti Honduras Hongrie Inde
    Indonésie Irak Iran Irlande Islande Israël Italie Jamaïque Japon Jordanie Kenya Laos Lettonie Liban
    Libye Lituanie Luxembourg Madagascar Malaisie Mali Maroc Mexique Monaco Mongolie Namibie Népal
    Nicaragua Niger Nigeria Norvège Oman Ouganda Ouzbékistan Pakistan Panama Paraguay Pérou Philippines
    Pologne Portugal Roumanie Russie Rwanda Sénégal Serbie Singapour Slovaquie Slovénie Soudan Suède
    Suisse Syrie Tchad Thaïlande Tunisie Turquie Togo Ukraine Uruguay Venezuela Vietnam`,

  metier: `Agriculteur Architecte Avocat Astronome Agent Ambulancier Boulanger Boucher Bibliothécaire
    Banquier Bijoutier Charpentier Chirurgien Coiffeur Comptable Cuisinier Couturier Chauffeur Dentiste
    Dessinateur Danseur Documentaliste Développeur Électricien Éboueur Écrivain Enseignant Ébéniste
    Éducateur Facteur Fleuriste Forgeron Fermier Fromager Garagiste Géologue Graphiste Gendarme
    Géomètre Horloger Hôtelier Historien Infirmier Ingénieur Imprimeur Instituteur Illustrateur
    Journaliste Jardinier Juge Jongleur Joaillier Libraire Luthier Logisticien Linguiste Maçon
    Mécanicien Médecin Menuisier Météorologue Maréchal-ferrant Notaire Nageur Nutritionniste Navigateur
    Opticien Ostéopathe Orfèvre Ouvrier Ophtalmologue Peintre Pharmacien Photographe Pilote Plombier
    Pompier Professeur Pâtissier Radiologue Réalisateur Restaurateur Routier Relieur Serrurier Sculpteur
    Secrétaire Soudeur Styliste Sommelier Tailleur Technicien Traducteur Tapissier Topographe Urbaniste
    Urologue Vétérinaire Vigneron Vendeur Verrier`,

  animal: `Abeille Aigle Âne Antilope Autruche Alpaga Baleine Belette Biche Bison Bœuf Buffle Blaireau
    Caméléon Canard Castor Cerf Chameau Chat Cheval Chien Chouette Cigogne Crabe Crocodile Dauphin Daim
    Dindon Dromadaire Dinde Écureuil Éléphant Escargot Épervier Étourneau Faisan Faucon Flamant Fourmi
    Furet Fouine Gazelle Gerbille Girafe Gorille Grenouille Guépard Hamster Hérisson Hibou Hippopotame
    Hirondelle Iguane Ibis Impala Jaguar Jars Jaseur Koala Lapin Léopard Lézard Lion Loup Loutre Lynx
    Marmotte Merle Moineau Mouette Mouton Mulot Mésange Narval Nandou Ours Otarie Orque Oie Panda
    Panthère Perdrix Perroquet Phoque Pigeon Pingouin Poule Puma Rat Raton Renard Requin Rhinocéros
    Rossignol Salamandre Sanglier Sardine Saumon Serpent Singe Souris Taupe Tigre Tortue Truite Vache
    Vautour Vipère Veau`,

  fruit_legume: `Abricot Ail Amande Ananas Artichaut Asperge Aubergine Avocat Banane Betterave Blette
    Brocoli Cassis Carotte Céleri Cerise Champignon Châtaigne Chou Citron Citrouille Concombre Courgette
    Cresson Clémentine Datte Échalote Endive Épinard Fenouil Fève Figue Fraise Framboise Goyave Grenade
    Groseille Gingembre Haricot Igname Jacque Kaki Kiwi Laitue Lentille Litchi Mâche Maïs Mandarine
    Mangue Melon Mirabelle Mûre Myrtille Navet Nectarine Noisette Noix Oignon Olive Orange Oseille
    Pamplemousse Panais Papaye Pastèque Pêche Persil Poire Poireau Poivron Pomme Potiron Prune Patate
    Radis Raisin Rhubarbe Rutabaga Salade Salsifis Tomate Topinambour Tamarin Vanille`,

  objet: `Agrafeuse Ampoule Aspirateur Assiette Armoire Aiguille Balai Ballon Bateau Bougie Bouteille
    Bracelet Brosse Bureau Cafetière Calculatrice Cahier Canapé Casquette Ceinture Chaise Chapeau
    Ciseaux Clé Clavier Couteau Crayon Cuillère Dé Diapason Disque Drap Dossier Échelle Écran Enveloppe
    Épingle Étagère Éventail Fauteuil Fourchette Four Fenêtre Ficelle Gant Gomme Guitare Gourde Grille
    Horloge Hamac Haltère Hache Imprimante Interrupteur Igloo Jumelles Jupe Journal Jouet Lampe Lit
    Livre Lunettes Lavabo Marteau Manteau Miroir Montre Moto Mixeur Maison Nappe Niveau Nécessaire
    Ordinateur Oreiller Outil Panier Parapluie Peigne Pelle Pinceau Pince Poêle Porte Radio Râteau Règle
    Réveil Rideau Sac Scie Serviette Stylo Seau Table Tabouret Tapis Téléphone Tournevis Tasse Télévision
    Urne Ustensile Valise Vase Vélo Ventilateur Violon Voiture`,
};

export const LEXICON_ENTRIES = Object.fromEntries(
  Object.entries(LEXICONS).map(([key, blob]) => [
    key,
    [...new Set(blob.split(/\s+/).map((w) => w.trim()).filter(Boolean))],
  ]),
);

// Suffixes caractéristiques : permettent de pressentir un métier inconnu du
// lexique sans l'accepter d'office (statut « à vérifier »).
export const METIER_SUFFIXES = [
  'eur', 'euse', 'ier', 'iere', 'ière', 'iste', 'ien', 'ienne', 'logue',
  'teur', 'trice', 'graphe', 'onnier', 'ancier', 'aire', 'ancière',
];
