import type { ProjectIcon, ProjectSummary } from '@app/shared';
import { useI18n } from 'vue-i18n';

/**
 * How a project is called in the interface: the personal project is "Osobiste" (its stored name is
 * n8n's `Jan Kowalski <jan@firma.pl>`), a team project by its name.
 */
export function useProjectName(): (project: Pick<ProjectSummary, 'type' | 'name'>) => string {
  const { t } = useI18n();
  return (project) => (project.type === 'personal' ? t('projects.personalName') : project.name);
}

/** Emoji offered as project icons (the server accepts any short text of type `emoji`). */
export const PROJECT_EMOJI: readonly string[] = [
  '📁',
  '🚀',
  '🤖',
  '🧠',
  '⚡',
  '🔧',
  '⚙️',
  '🛠️',
  '📊',
  '📈',
  '💼',
  '🏢',
  '🛒',
  '📦',
  '🚚',
  '💰',
  '🧾',
  '📣',
  '✉️',
  '💬',
  '📞',
  '📅',
  '📝',
  '📚',
  '🔍',
  '🔒',
  '🌐',
  '☁️',
  '🗄️',
  '🧪',
  '🎯',
  '🏆',
  '💡',
  '🔥',
  '⭐',
  '❤️',
  '🌱',
  '🏠',
  '🎨',
  '🎵',
  '🍕',
  '☕',
  '🐶',
  '🐱',
  '🦊',
  '🐝',
  '🌍',
  '🇵🇱',
];

export function emojiIcon(value: string): ProjectIcon {
  return { type: 'emoji', value };
}
