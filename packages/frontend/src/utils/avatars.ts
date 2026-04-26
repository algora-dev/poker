export interface AvatarOption {
  id: number;
  name: string;
  src: string;
}

export const AVATARS: AvatarOption[] = [
  { id: 1, name: 'Sunglasses', src: '/assets/avatars/1-sunglasses.png' },
  { id: 2, name: 'Hooded', src: '/assets/avatars/2-hooded.png' },
  { id: 3, name: 'Shark', src: '/assets/avatars/3-shark.png' },
  { id: 4, name: 'Android', src: '/assets/avatars/4-android.png' },
  { id: 5, name: 'Cowboy', src: '/assets/avatars/5-cowboy.png' },
  { id: 6, name: 'Ninja', src: '/assets/avatars/6-ninja.png' },
  { id: 7, name: 'King', src: '/assets/avatars/7-king.png' },
  { id: 8, name: 'Fox', src: '/assets/avatars/8-fox.png' },
  { id: 9, name: 'Diamond', src: '/assets/avatars/9-diamond.png' },
  { id: 10, name: 'Flame', src: '/assets/avatars/10-flame.png' },
];

export function getAvatarById(id: number): AvatarOption {
  return AVATARS.find(a => a.id === id) || AVATARS[0];
}

export function getAvatarSrc(id: number | null | undefined): string | null {
  if (!id) return null;
  const avatar = AVATARS.find(a => a.id === id);
  return avatar?.src || null;
}
