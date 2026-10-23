// Les 8 rubriques officielles, dans l'ordre imposé. Aucune rubrique supplémentaire.
export const CATEGORIES = [
  {
    key: 'prenom_fille',
    label: 'Prénom fille',
    icon: '♀',
    placeholder: 'un prénom féminin',
    rule: "Un prénom féminin réellement porté (français, étranger, rare ou variante reconnue). Un prénom mixte réellement utilisé pour des filles est accepté. Refuser un nom de famille sans usage de prénom, un objet, une ville ou un mot inventé.",
  },
  {
    key: 'prenom_garcon',
    label: 'Prénom garçon',
    icon: '♂',
    placeholder: 'un prénom masculin',
    rule: "Un prénom masculin réellement porté (français, étranger, rare ou variante reconnue). Un prénom mixte réellement utilisé pour des garçons est accepté. Ne pas confondre avec un nom de famille, un personnage de fiction sans usage de prénom, un objet ou une ville.",
  },
  {
    key: 'ville',
    label: 'Ville',
    icon: '🏙',
    placeholder: 'une ville ou commune',
    rule: "Une ville ou localité réelle et identifiable, en France ou à l'étranger, y compris les petites communes peu connues. Ne pas rejeter une ville au seul motif qu'elle est peu connue. Un pays, un continent, une région ou un département n'est PAS une ville.",
  },
  {
    key: 'pays',
    label: 'Pays',
    icon: '🌍',
    placeholder: 'un pays',
    rule: "Un pays reconnu, sous son nom français ou une appellation courante non ambiguë. Distinguer du nom d'une ville, d'une région, d'un continent ou d'une nationalité.",
  },
  {
    key: 'metier',
    label: 'Métier',
    icon: '🛠',
    placeholder: 'une profession',
    rule: "Une véritable profession ou activité professionnelle (moderne, ancienne, artisanale, scientifique, artistique, technique, rare). Les variantes orthographiques et les formes féminines/masculines sont acceptées. Un objet, un animal, un lieu, une qualité personnelle ou un loisir n'est PAS un métier.",
  },
  {
    key: 'animal',
    label: 'Animal',
    icon: '🦊',
    placeholder: 'un animal',
    rule: "Un animal identifiable : domestique ou sauvage, mammifère, oiseau, poisson, reptile, amphibien, insecte, mollusque, y compris les espèces peu connues et les noms usuels. Une plante, un objet ou un métier n'est PAS un animal.",
  },
  {
    key: 'fruit_legume',
    label: 'Fruit / légume',
    icon: '🍏',
    placeholder: 'un fruit ou un légume',
    rule: "Un fruit ou un légume reconnu dans un usage alimentaire courant, y compris les variétés peu connues et les appellations usuelles. Classer selon l'usage alimentaire courant et non selon la botanique stricte (la tomate, la courgette ou l'avocat sont acceptés). Une fleur non consommée, une céréale non consommée comme légume, un animal ou un objet n'est PAS un fruit/légume.",
  },
  {
    key: 'objet',
    label: 'Objet',
    icon: '📦',
    placeholder: 'un objet matériel',
    rule: "Un objet matériel identifiable : objet du quotidien, outil, appareil, meuble, vêtement, véhicule, instrument, objet technique. Une personne, un pays, une ville, un animal, un aliment vivant ou un concept abstrait n'est PAS un objet.",
  },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function labelOf(key) {
  return CATEGORY_BY_KEY.get(key)?.label ?? key;
}
