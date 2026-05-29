/**
 * Anonymous animal name generator — follows Google Docs / Canva pattern.
 * Deterministically maps a session ID to one of 73 animals.
 */

const ANIMALS = [
  'Alligator',
  'Ant',
  'Badger',
  'Bat',
  'Bear',
  'Beaver',
  'Bee',
  'Bird',
  'Bison',
  'Boar',
  'Buffalo',
  'Bull',
  'Butterfly',
  'Camel',
  'Cat',
  'Cobra',
  'Cod',
  'Cougar',
  'Coyote',
  'Crane',
  'Crow',
  'Deer',
  'Dingo',
  'Dolphin',
  'Dove',
  'Dragon',
  'Duck',
  'Eagle',
  'Eel',
  'Elk',
  'Falcon',
  'Finch',
  'Fox',
  'Frog',
  'Gazelle',
  'Gecko',
  'Goat',
  'Goose',
  'Gorilla',
  'Hamster',
  'Hare',
  'Hawk',
  'Hippo',
  'Horse',
  'Hyena',
  'Iguana',
  'Impala',
  'Jackal',
  'Jaguar',
  'Kangaroo',
  'Koala',
  'Lemur',
  'Leopard',
  'Lion',
  'Llama',
  'Lobster',
  'Lynx',
  'Mantis',
  'Mole',
  'Moose',
  'Mule',
  'Newt',
  'Otter',
  'Owl',
  'Panda',
  'Panther',
  'Parrot',
  'Pelican',
  'Penguin',
  'Pig',
  'Puma',
  'Rabbit',
  'Raccoon',
  'Ram',
  'Raven',
] as const;

/**
 * Deterministically maps a string ID to an anonymous animal name.
 * Same ID always returns the same name.
 */
export function getAnonymousName(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % ANIMALS.length;
  return `Anonymous ${ANIMALS[index]}`;
}

/**
 * Returns just the animal name (lowercase) for use as an identifier.
 */
export function getAnonymousAnimal(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % ANIMALS.length;
  return (ANIMALS[index] ?? 'Fox').toLowerCase();
}

/**
 * Returns the first letter of the animal for avatar display.
 */
export function getAnonymousInitial(id: string): string {
  const name = getAnonymousAnimal(id);
  return name.charAt(0).toUpperCase();
}

/**
 * Deterministic emoji for each animal. Uses the closest widely-supported
 * Unicode emoji match — approximate for species without a direct emoji.
 */
const ANIMAL_EMOJI: Record<string, string> = {
  alligator: '🐊',
  ant: '🐜',
  badger: '🦡',
  bat: '🦇',
  bear: '🐻',
  beaver: '🦫',
  bee: '🐝',
  bird: '🐦',
  bison: '🦬',
  boar: '🐗',
  buffalo: '🐃',
  bull: '🐂',
  butterfly: '🦋',
  camel: '🐫',
  cat: '🐱',
  cobra: '🐍',
  cod: '🐟',
  cougar: '🐆',
  coyote: '🐺',
  crane: '🦩',
  crow: '🐦‍⬛',
  deer: '🦌',
  dingo: '🐕',
  dolphin: '🐬',
  dove: '🕊️',
  dragon: '🐉',
  duck: '🦆',
  eagle: '🦅',
  eel: '🐍',
  elk: '🦌',
  falcon: '🦅',
  finch: '🐦',
  fox: '🦊',
  frog: '🐸',
  gazelle: '🦌',
  gecko: '🦎',
  goat: '🐐',
  goose: '🪿',
  gorilla: '🦍',
  hamster: '🐹',
  hare: '🐇',
  hawk: '🦅',
  hippo: '🦛',
  horse: '🐴',
  hyena: '🐺',
  iguana: '🦎',
  impala: '🦌',
  jackal: '🐺',
  jaguar: '🐆',
  kangaroo: '🦘',
  koala: '🐨',
  lemur: '🐒',
  leopard: '🐆',
  lion: '🦁',
  llama: '🦙',
  lobster: '🦞',
  lynx: '🐱',
  mantis: '🦗',
  mole: '🐹',
  moose: '🦌',
  mule: '🐴',
  newt: '🦎',
  otter: '🦦',
  owl: '🦉',
  panda: '🐼',
  panther: '🐆',
  parrot: '🦜',
  pelican: '🦩',
  penguin: '🐧',
  pig: '🐷',
  puma: '🐆',
  rabbit: '🐇',
  raccoon: '🦝',
  ram: '🐏',
  raven: '🐦‍⬛',
};

/**
 * Returns an emoji representing the animal for the given anonymous ID.
 * Same ID always returns the same emoji.
 */
export function getAnimalEmoji(id: string): string {
  const animal = getAnonymousAnimal(id);
  return ANIMAL_EMOJI[animal] ?? '🐾';
}
