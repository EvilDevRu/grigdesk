<template>
  <div class="page">
    <p class="hint">
      Проект = имя + пути репозиториев на диске; схемы конвейера привязаны к нему по имени.
      <UiTooltip :text="help" />
    </p>

    <div v-if="error" class="err">{{ error }}</div>
    <div v-if="loading" class="empty">Загрузка…</div>

    <template v-else>
      <div class="cards">
        <section v-for="p in projects" :key="p.id" class="card">
          <header class="chead">
            <span class="cname mono">{{ p.id }}</span>
            <span class="src" :class="{ fab: p.factory }">{{ p.factory ? 'профиль фабрики' : 'кокпит' }}</span>
          </header>

          <!-- Репозитории -->
          <div v-if="edit?.id !== p.id" class="repos">
            <div v-if="!p.repos.length" class="muted">Пути репозиториев не заданы</div>
            <div v-for="r in p.repos" :key="r.key" class="repo">
              <span class="rkey mono">{{ r.key }}</span>
              <span class="rdir mono" :title="r.dir">{{ r.dir }}</span>
              <span class="dot" :class="r.exists ? 'ok' : 'no'" :title="r.exists ? 'есть на диске' : 'нет на диске'"></span>
            </div>
          </div>

          <!-- Редактор путей (кокпитные проекты и фабричные без путей в профиле) -->
          <div v-else class="editbox">
            <div v-for="(r, i) in edit.repos" :key="i" class="erow">
              <UiInput v-model="r.key" class="ekey mono" placeholder="service" title="Метка репозитория (service, docs…)" />
              <UiInput v-model="r.dir" class="edir mono" placeholder="/workspace/sample/service" title="Абсолютный путь к корню git-репозитория" />
              <UiIconButton class="act" label="Убрать строку" title="Убрать строку" @click="delRow(i)">✕</UiIconButton>
            </div>
            <div class="ebtns">
              <UiButton class="act" @click="addRow">+ репозиторий</UiButton>
              <span class="grow"></span>
              <span v-if="edit.msg" class="emsg">{{ edit.msg }}</span>
              <UiButton class="act" @click="edit = null">Отмена</UiButton>
              <UiButton class="act pri" tone="accent" :loading="edit.saving" loading-label="Сохраняю" @click="save">Сохранить</UiButton>
            </div>
          </div>

          <!-- Схемы конвейера проекта -->
          <div class="routes">
            <span class="muted">Схемы:</span>
            <template v-if="p.routes.length">
              <UiButton v-for="r in p.routes" :key="r" class="rchip mono" variant="ghost" title="Открыть в «Маршрутах»" @click="toRoutes(p.id)">{{ r }}</UiButton>
            </template>

            <span v-else class="muted">нет</span>
          </div>

          <footer class="cfoot">
            <UiButton v-if="canEdit(p) && edit?.id !== p.id" class="act" @click="startEdit(p)">Пути…</UiButton>
            <UiTooltip
              v-else-if="!canEdit(p)"
              text="Пути задаёт профиль фабрики (PROFILE_TRIAGE_REPOS в profiles/<имя>/profile.sh) — здесь они только показываются."
            />
            <span class="grow"></span>
            <UiButton v-if="p.repos.length" class="act" @click="toCode(p.id)">Код →</UiButton>
          </footer>
        </section>

        <!-- Новый проект -->
        <section class="card newcard">
          <header class="chead"><span class="cname">Новый проект</span></header>
          <p class="muted sm">Появится в «Маршрутах» и здесь; пути репозиториев задаются после создания.</p>
          <div class="erow">
            <UiInput v-model="newId" class="edir mono" placeholder="id: строчные латиница/цифры/-/_" @keyup.enter="create" />
            <UiButton class="act pri" tone="accent" :loading="creating" :disabled="!newId.trim()" loading-label="Создаю" @click="create">Создать</UiButton>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// Раздел «Проекты»: реестр проектов с путями репозиториев на диске.
// Проект — это то же имя, что профиль фабрики и папка базы маршрутов (routes/<id>).
// Пути фабричного проекта показываются из его bash-профиля (единственный источник,
// тут они read-only); у кокпитного проекта пути редактируются здесь и живут в prefs.
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';

import type { Project, ProjectRepoInput } from '../../../shared/projectsContracts.ts';
import { failureText } from '../shared/apiClient.ts';
import { projectsApi } from '../shared/projectsApi.ts';
import {
  UiButton,
  UiIconButton,
  UiInput,
  UiTooltip,
  alertDialog,
} from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useToolLauncher } from '../shared/tools/launcher.ts';

// Открытый редактор путей одного проекта. Строки — черновик формы: пустая пара
// «метка/путь» здесь законна, а отфильтрует её сохранение.
interface RepoEditor {
  id: string;
  repos: ProjectRepoInput[];
  saving: boolean;
  msg: string;
}

const PROJECT_KEY = 'cockpit-project';

const router = useRouter();
const { openCode } = useToolLauncher();
const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref('');
const newId = ref('');
const creating = ref(false);
const edit = ref<RepoEditor | null>(null);
const projectsContext = useUiContextSource('projects', { layer: 'page', active: false });

watch(() => edit.value?.id || '', (project) => {
  // Карточки не имеют выбранного repository: публикуем только реально открытый editor,
  // не первый путь и не абсолютные `dir` из формы.
  if (project) {
    projectsContext.focus({ details: { project } });
  } else {
    projectsContext.blur();
  }
}, { immediate: true });

const help = 'Проект связывает всё по имени: профиль фабрики, схемы конвейера'
  + ' (раздел «Маршруты») и пути репозиториев на диске — их читает плагин «Код».'
  + ' У проекта фабрики пути задаёт его профиль (PROFILE_TRIAGE_REPOS); у проекта,'
  + ' заведённого здесь, пути хранятся в кокпите.';

/**
 * Перечитывает реестр проектов. Отказ показывается ВМЕСТО списка, а не поверх
 * пустого: иначе «проектов нет» и «не удалось прочитать» выглядят одинаково.
 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';

  try {
    projects.value = await projectsApi.list();
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/**
 * Пути правятся у кокпитных проектов И у фабричных БЕЗ путей в профиле (кокпитный
 * фолбэк): сервер в этом случае PUT принимает, и прятать кнопку было бы нечестно.
 * Фабричные пути остаются read-only — их источник один, и это профиль.
 */
function canEdit(project: Project): boolean {
  return !project.factory || !project.repos.some((repo) => repo.from === 'factory');
}

/** Открывает редактор путей. У проекта без путей показывается одна пустая строка. */
function startEdit(project: Project): void {
  edit.value = {
    id: project.id,
    repos: project.repos.length
      ? project.repos.map((repo) => ({ key: repo.key, dir: repo.dir }))
      : [{ key: '', dir: '' }],
    saving: false,
    msg: '',
  };
}

function addRow(): void {
  edit.value?.repos.push({ key: '', dir: '' });
}

function delRow(index: number): void {
  edit.value?.repos.splice(index, 1);
}

/**
 * Заводит проект и сразу открывает ему редактор путей: ради путей его и создают,
 * а пустая карточка в списке ничего не объясняет.
 */
async function create(): Promise<void> {
  const id = newId.value.trim();

  if (!id) {
    return;
  }

  creating.value = true;

  try {
    await projectsApi.create(id);
    newId.value = '';
    await load();

    const created = projects.value.find((project) => project.id === id);

    if (created) {
      startEdit(created);
    }
  } catch (failure) {
    alertDialog(`Не удалось создать проект: ${failureText(failure)}`);
  } finally {
    creating.value = false;
  }
}

/**
 * Сохраняет пути. Пустые строки формы отбрасываются, а отказ остаётся В редакторе:
 * закрыть его значило бы потерять набранное вместе с причиной отказа.
 */
async function save(): Promise<void> {
  const editor = edit.value;

  if (!editor || editor.saving) {
    return;
  }

  const repos = editor.repos
    .map((repo) => ({ key: repo.key.trim(), dir: repo.dir.trim() }))
    .filter((repo) => repo.key || repo.dir);

  editor.saving = true;
  editor.msg = '';

  try {
    await projectsApi.saveRepos(editor.id, repos);
    edit.value = null;
    await load();
  } catch (failure) {
    editor.msg = failureText(failure);
    editor.saving = false;
  }
}

/**
 * Клик по схеме ведёт в «Маршруты» с уже выбранным проектом: раздел читает выбор
 * из localStorage — тот же ключ, что у переключателя проектов.
 */
function toRoutes(id: string): void {
  localStorage.setItem(PROJECT_KEY, id);
  router.push('/routes');
}

function toCode(id: string): void {
  openCode({ project: id });
}
</script>

<style scoped>
.page { max-width: 1100px; }
.hint { margin: 0 0 16px; color: var(--ink-mid); font-size: 13px; display: flex; align-items: center; gap: 6px; }
.err { color: var(--bad); margin-bottom: 12px; }
.empty { color: var(--ink-mid); padding: 30px 0; text-align: center; }
.muted { color: var(--ink-mid); font-size: 12.5px; }
.sm { font-size: 12px; margin: 0 0 10px; }
.grow { flex: 1; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px; }
.newcard { border-style: dashed; background: none; }
.chead { display: flex; align-items: center; gap: 10px; }
.cname { font-size: 15px; font-weight: 650; }
.src { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); color: var(--ink-mid); }
.src.fab { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }

.repos { display: flex; flex-direction: column; gap: 5px; }
.repo { display: flex; align-items: center; gap: 8px; font-size: 12.5px; min-width: 0; }
.rkey { flex: none; min-width: 26px; padding: 1px 7px; border-radius: 6px; background: var(--surface-2); color: var(--accent); font-size: 11.5px; }
.rdir { color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.dot.ok { background: var(--good); }
.dot.no { background: var(--bad); }

.editbox { display: flex; flex-direction: column; gap: 7px; }
.erow { display: flex; align-items: center; gap: 7px; }
.ekey { width: 58px; flex: none; }
.edir { flex: 1; min-width: 0; }
.ebtns { display: flex; align-items: center; gap: 7px; }
.emsg { color: var(--bad); font-size: 11.5px; }

.routes { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rchip { flex: none; }

.cfoot { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.act { flex: none; }
</style>
