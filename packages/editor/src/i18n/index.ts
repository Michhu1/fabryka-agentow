import type { GlobalRole, ProjectRole } from '@app/shared';
import { createI18n } from 'vue-i18n';
import pl from './pl.json';

export type MessageSchema = typeof pl;

/** The editor's translations. Polish only for now; the structure is ready for more languages. */
export function createAppI18n() {
  return createI18n<[MessageSchema], 'pl', false>({
    legacy: false,
    locale: 'pl',
    fallbackLocale: 'pl',
    messages: { pl },
  });
}

export const i18n = createAppI18n();

/** i18n key of a project role's name ("Właściciel", "Edytor", "Podgląd"). */
export function projectRoleKey(role: ProjectRole): string {
  return `projects.roles.${role.replace('project:', '')}`;
}

/** i18n key of an instance role's name ("Właściciel platformy", "Administrator", "Użytkownik"). */
export function globalRoleKey(role: GlobalRole): string {
  return `settings.roles.${role.replace('global:', '')}`;
}
