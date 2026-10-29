<script setup lang="ts">
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useAuthStore } from '../../stores/auth';

/** The signed-in person at the bottom of the sidebar; opens "Ustawienia" and "Wyloguj się". */
const auth = useAuthStore();
const { t } = useI18n();

const fullName = computed(() => `${auth.user?.firstName ?? ''} ${auth.user?.lastName ?? ''}`.trim());
const initials = computed(() =>
  `${auth.user?.firstName.charAt(0) ?? ''}${auth.user?.lastName.charAt(0) ?? ''}`.toUpperCase(),
);
</script>

<template>
  <DropdownMenuRoot v-if="auth.user">
    <DropdownMenuTrigger
      class="user-menu__trigger"
      :aria-label="t('nav.accountMenu', { name: fullName })"
      data-test="user-menu"
    >
      <span class="user-menu__avatar" aria-hidden="true">{{ initials }}</span>
      <span class="user-menu__who">
        <span class="user-menu__name">{{ fullName }}</span>
        <span class="user-menu__email">{{ auth.user.email }}</span>
      </span>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="user-menu" side="top" align="start" :side-offset="6">
        <DropdownMenuItem as-child class="user-menu__item">
          <RouterLink to="/settings/personal" data-test="menu-settings">{{ t('nav.settings') }}</RouterLink>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="user-menu__separator" />
        <DropdownMenuItem class="user-menu__item" data-test="menu-logout" @select="auth.logout()">
          {{ t('common.logout') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style>
/* Not scoped: the menu is teleported to <body>. */
.user-menu__trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.user-menu__trigger:hover,
.user-menu__trigger[data-state='open'] {
  background: var(--color-nav-hover);
}
.user-menu__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: var(--icon-size-md);
  height: var(--icon-size-md);
  border-radius: 50%;
  background: var(--color-avatar);
  color: var(--color-on-avatar);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}
.user-menu__who {
  display: grid;
  min-width: 0;
}
.user-menu__name,
.user-menu__email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-menu__name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.user-menu__email {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.user-menu {
  z-index: 60;
  min-width: calc(var(--sidebar-width) - 2 * var(--space-3));
  padding: var(--space-1);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
}
.user-menu__item {
  display: flex;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-md);
  cursor: pointer;
  outline: none;
}
.user-menu__item:hover {
  text-decoration: none;
}
.user-menu__item[data-highlighted] {
  background: var(--color-surface-muted);
}
.user-menu__separator {
  height: var(--border-width);
  margin: var(--space-1) 0;
  background: var(--color-border);
}
</style>
