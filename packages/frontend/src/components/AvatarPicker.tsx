import { useState } from 'react';
import { AVATARS, AvatarOption } from '../utils/avatars';
import { api } from '../services/api';

interface AvatarPickerProps {
  currentAvatarId: number | null;
  onSelect: (avatarId: number) => void;
  isOpen: boolean;
  onClose: () => void;
}

export function AvatarPicker({ currentAvatarId, onSelect, isOpen, onClose }: AvatarPickerProps) {
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleSelect = async (avatar: AvatarOption) => {
    try {
      setSaving(true);
      await api.post('/api/auth/avatar', { avatarId: avatar.id });
      onSelect(avatar.id);
      onClose();
    } catch (err) {
      console.error('Failed to save avatar', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-brand-bg rounded-2xl p-6 max-w-md w-full border border-white/10 shadow-2xl">
        <h2 className="text-lg font-bold text-white text-center mb-5">Choose Your Avatar</h2>
        
        <div className="grid grid-cols-5 gap-3 mb-6">
          {AVATARS.map((avatar) => (
            <button
              key={avatar.id}
              onClick={() => handleSelect(avatar)}
              disabled={saving}
              className={`
                relative w-16 h-16 rounded-full overflow-hidden transition-all
                hover:scale-110 hover:ring-2 hover:ring-brand-cyan
                ${currentAvatarId === avatar.id ? 'ring-[3px] ring-brand-cyan scale-105' : 'ring-1 ring-white/10'}
                disabled:opacity-50
              `}
            >
              <img src={avatar.src} alt={avatar.name} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>

        <button
          onClick={onClose}
          className="w-full py-2 bg-white/5 text-gray-400 rounded-lg hover:bg-white/10 transition text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
