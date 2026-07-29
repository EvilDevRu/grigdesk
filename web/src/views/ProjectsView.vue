<script setup>
// Раздел «Проекты»: реестр проектов с путями репозиториев на диске.
// Проект — это то же имя, что профиль фабрики и папка базы маршрутов (routes/<id>).
// Пути фабричного проекта показываются из его bash-профиля (единственный источник,
// тут они read-only); у кокпитного проекта пути редактируются здесь и живут в prefs.
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import { alertDialog } from '../shared/ui/confirm.js';
import HelpTip from '../shared/ui/HelpTip.vue';

const router = useRouter();
const projects = ref([]);
const loading = ref(true);
const error = ref('');
const newId = ref('');
const creating = ref(false);
// Редактор путей: { id, repos: [{key, dir}], saving, msg } — открыт для одного проекта.
const edit = ref(null);
// GitHub-привязка отдельна от пути: фабричный путь read-only, а review-настройки
// всё равно можно подтвердить и менять из Cockpit.
const githubEdit = ref(null);
const repoBusy = ref('');

const HELP = 'Проект связывает всё по имени: профиль фабрики, схемы конвейера (раздел «Маршруты») и пути репозиториев на диске — их читает плагин «Код». У проекта фабрики пути задаёт его профиль (PROFILE_TRIAGE_REPOS); у проекта, заведённого здесь, пути хранятся в кокпите.';

async function load() {
  loading.value = true; error.value = '';
  try { projects.value = (await api.get('/api/projects')).projects || []; }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(load);

async function create() {
  const id = newId.value.trim();
  if (!id) return;
  creating.value = true;
  try {
    await api.post('/api/profiles', { id });
    newId.value = '';
    await load();
    // Свежезаведённому проекту сразу открываем редактор путей — ради них он и заводился.
    const p = projects.value.find((x) => x.id === id);
    if (p) startEdit(p);
  } catch (e) { alertDialog(`Не удалось создать проект: ${e.message}`); }
  finally { creating.value = false; }
}

// Пути правятся у кокпитных проектов И у фабричных БЕЗ путей в профиле (кокпитный фолбэк):
// сервер в этом случае PUT принимает, прятать кнопку нечестно. Фабричные пути — read-only.
function canEdit(p) { return !p.factory || !p.repos.some((r) => r.from === 'factory'); }

function startEdit(p) {
  edit.value = {
    id: p.id,
    repos: p.repos.length ? p.repos.map((r) => ({ key: r.key, dir: r.dir })) : [{ key: '', dir: '' }],
    saving: false,
    msg: '',
  };
}
function addRow() { edit.value?.repos.push({ key: '', dir: '' }); }
function delRow(i) { edit.value?.repos.splice(i, 1); }

async function save() {
  if (!edit.value || edit.value.saving) return;
  const repos = edit.value.repos
    .map((r) => ({ key: r.key.trim(), dir: r.dir.trim() }))
    .filter((r) => r.key || r.dir);
  edit.value.saving = true; edit.value.msg = '';
  try {
    await api.put(`/api/projects/${edit.value.id}`, { repos });
    edit.value = null;
    await load();
  } catch (e) {
    edit.value.msg = e.message;
    edit.value.saving = false;
  }
}

// Клик по схеме ведёт в «Маршруты» с уже выбранным проектом: раздел читает выбор
// из localStorage (тот же ключ, что у переключателя проектов).
function toRoutes(id) {
  localStorage.setItem('cockpit-project', id);
  router.push('/routes');
}
function toCode(id) {
  localStorage.setItem('cockpit-project', id);
  router.push('/code');
}
function toReviews(id) {
  localStorage.setItem('cockpit-project', id);
  router.push({ path: '/reviews', query: { project: id } });
}

function startGithubEdit(project, repo) {
  const github = repo.github || {};
  githubEdit.value = {
    projectId: project.id,
    repoKey: repo.key,
    slug: github.slug || github.detectedSlug || '',
    autoSync: github.confirmed ? github.autoSync !== false : true,
    autoAnalyze: github.confirmed ? github.autoAnalyze !== false : true,
    verifyText: (github.verifyCommands || []).join('\n'),
    verifyCoversCriteria: github.verifyCoversCriteria === true,
    saving: false,
    msg: github.mismatch ? 'Сохранённая привязка расходится с git remote.' : '',
  };
}

async function saveGithub() {
  const form = githubEdit.value;
  if (!form || form.saving) return;
  form.saving = true;
  form.msg = '';
  try {
    await api.put(`/api/projects/${form.projectId}/repositories/${form.repoKey}/github`, {
      slug: form.slug.trim(),
      confirmed: true,
      autoSync: form.autoSync,
      autoAnalyze: form.autoAnalyze,
      verifyCommands: form.verifyText.split('\n').map((line) => line.trim()).filter(Boolean),
      verifyCoversCriteria: form.verifyCoversCriteria === true,
    });
    githubEdit.value = null;
    await load();
  } catch (e) {
    form.msg = e.message;
    form.saving = false;
  }
}

async function checkGithub(project, repo) {
  const key = `${project.id}:${repo.key}`;
  if (repoBusy.value) return;
  repoBusy.value = key;
  try {
    const result = await api.post(`/api/projects/${project.id}/repositories/${repo.key}/github/check`);
    await alertDialog(`GitHub доступен: ${result.slug}`);
  } catch (e) {
    await alertDialog(`GitHub недоступен: ${e.message}`);
  } finally {
    repoBusy.value = '';
  }
}

async function syncReviews(project, repo) {
  const key = `${project.id}:${repo.key}`;
  if (repoBusy.value) return;
  repoBusy.value = key;
  try {
    await api.post('/api/reviews/sync', { projectId: project.id, repoKey: repo.key });
    toReviews(project.id);
  } catch (e) {
    await alertDialog(`Не удалось проверить PR: ${e.message}`);
  } finally {
    repoBusy.value = '';
  }
}

function reviewConfigurationMessage(status) {
  if (status?.configurationError?.message) return String(status.configurationError.message);
  if (!status?.reviewRoute) return 'не выбран маршрут исправления';
  return 'не подтверждены обязательные проверки проекта';
}
</script>

<template>
  <div class="page">
    <p class="hint">
      Проект = имя + пути репозиториев на диске; схемы конвейера привязаны к нему по имени.
      <HelpTip :text="HELP" />
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
              <input v-model="r.key" class="ekey mono" placeholder="be" title="Метка репозитория (be, fe…)" />
              <input v-model="r.dir" class="edir mono" placeholder="/home/…/Workspace/проект/be" title="Абсолютный путь к корню git-репозитория" />
              <button class="act" title="Убрать строку" @click="delRow(i)">✕</button>
            </div>
            <div class="ebtns">
              <button class="act" @click="addRow">+ репозиторий</button>
              <span class="grow"></span>
              <span v-if="edit.msg" class="emsg">{{ edit.msg }}</span>
              <button class="act" @click="edit = null">Отмена</button>
              <button class="act pri" :disabled="edit.saving" @click="save">{{ edit.saving ? 'Сохраняю…' : 'Сохранить' }}</button>
            </div>
          </div>

          <!-- GitHub и автоматическое ревью -->
          <div v-for="r in p.repos" :key="`gh:${r.key}`" class="githubbox">
            <template v-if="githubEdit?.projectId === p.id && githubEdit?.repoKey === r.key">
              <div class="ghline">
                <span class="rkey mono">{{ r.key }}</span>
                <input v-model="githubEdit.slug" class="ghslug mono" placeholder="owner/repository" />
              </div>
              <label class="ghcheck"><input v-model="githubEdit.autoSync" type="checkbox" /> автоматически искать замечания</label>
              <label class="ghcheck"><input v-model="githubEdit.autoAnalyze" type="checkbox" /> автоматически объяснять их</label>
              <label class="muted">Команды проверки — по одной на строке</label>
              <textarea v-model="githubEdit.verifyText" class="ghcommands mono" rows="3"
                        placeholder="npm test&#10;npm run build"></textarea>
              <label class="ghcheck">
                <input v-model="githubEdit.verifyCoversCriteria" type="checkbox" />
                эти команды действительно проверяют критерии готовности замечаний
              </label>
              <span v-if="githubEdit.msg" class="emsg">{{ githubEdit.msg }}</span>
              <div class="ghactions">
                <button class="act" @click="githubEdit = null">Отмена</button>
                <button class="act pri" :disabled="githubEdit.saving || !githubEdit.slug.trim()" @click="saveGithub">
                  {{ githubEdit.saving ? 'Сохраняю…' : 'Подтвердить привязку' }}
                </button>
              </div>
            </template>
            <template v-else>
              <div class="ghline">
                <span class="rkey mono">{{ r.key }}</span>
                <span class="ghname mono" :class="{ bad: r.github?.mismatch }">
                  {{ r.github?.slug || r.github?.detectedSlug || 'GitHub не найден' }}
                </span>
                <span class="dot" :class="r.github?.confirmed ? 'ok' : 'no'"
                      :title="r.github?.confirmed ? 'привязка подтверждена' : r.github?.mismatch ? 'remote изменился' : 'нужно подтвердить'"></span>
              </div>
              <div class="ghmeta">
                <span v-if="r.github?.confirmed">{{ r.github.autoSync ? 'автообновление' : 'ручное обновление' }}</span>
                <span v-if="r.github?.confirmed">· {{ r.github.autoAnalyze ? 'автоанализ' : 'без автоанализа' }}</span>
                <span v-if="r.reviewStatus">
                  · открыто PR: {{ r.reviewStatus.openPullRequests }},
                  требуют внимания: {{ r.reviewStatus.attentionPullRequests }}
                </span>
                <span
                  v-if="r.reviewStatus?.canFix && r.reviewStatus.reviewRoute"
                  class="review-capability ok-text"
                >
                  · может исправлять через
                  <code>{{ r.reviewStatus.reviewRoute.profileId }}/{{ r.reviewStatus.reviewRoute.routeId }}</code>
                </span>
                <span
                  v-else-if="r.reviewStatus"
                  class="review-capability muted"
                >
                  · только просмотр: {{ reviewConfigurationMessage(r.reviewStatus) }}
                </span>
                <span v-if="r.reviewStatus?.lastSyncAt">
                  · проверено {{ new Date(r.reviewStatus.lastSyncAt).toLocaleString('ru') }}
                </span>
                <span v-if="r.reviewStatus?.lastSyncError" class="bad">
                  · последняя проверка не удалась
                </span>
                <span
                  v-if="r.reviewStatusError"
                  class="bad review-status-error"
                  role="alert"
                >
                  · {{ r.reviewStatusError.message || 'состояние ревью временно недоступно' }}
                </span>
                <span v-if="r.github?.mismatch" class="bad">git remote изменился</span>
              </div>
              <div class="ghactions">
                <button class="act" @click="startGithubEdit(p, r)">
                  {{ r.github?.confirmed ? 'Настроить' : 'Привязать' }}
                </button>
                <button v-if="r.github?.slug || r.github?.detectedSlug" class="act"
                        :disabled="!!repoBusy" @click="checkGithub(p, r)">Доступ</button>
                <button v-if="r.github?.confirmed" class="act pri"
                        :disabled="!!repoBusy" @click="syncReviews(p, r)">Проверить сейчас</button>
              </div>
            </template>
          </div>

          <!-- Схемы конвейера проекта -->
          <div class="routes">
            <span class="muted">Схемы:</span>
            <template v-if="p.routes.length">
              <button v-for="r in p.routes" :key="r" class="rchip mono" title="Открыть в «Маршрутах»" @click="toRoutes(p.id)">{{ r }}</button>
            </template>
            <span v-else class="muted">нет</span>
          </div>

          <footer class="cfoot">
            <button v-if="canEdit(p) && edit?.id !== p.id" class="act" @click="startEdit(p)">Пути…</button>
            <HelpTip v-else-if="!canEdit(p)" text="Пути задаёт профиль фабрики (PROFILE_TRIAGE_REPOS в profiles/<имя>/profile.sh) — здесь они только показываются." />
            <span class="grow"></span>
            <button v-if="p.reviewReady" class="act" @click="toReviews(p.id)">Ревью →</button>
            <button v-if="p.repos.length" class="act" @click="toCode(p.id)">Код →</button>
          </footer>
        </section>

        <!-- Новый проект -->
        <section class="card newcard">
          <header class="chead"><span class="cname">Новый проект</span></header>
          <p class="muted sm">Появится в «Маршрутах» и здесь; пути репозиториев задаются после создания.</p>
          <div class="erow">
            <input v-model="newId" class="edir mono" placeholder="id: строчные латиница/цифры/-/_" @keyup.enter="create" />
            <button class="act pri" :disabled="creating || !newId.trim()" @click="create">{{ creating ? '…' : 'Создать' }}</button>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

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
.erow input { padding: 5px 9px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--surface-2);
  color: var(--ink); font-size: 12px; }
.erow input:focus { outline: none; border-color: var(--accent); }
.ekey { width: 58px; flex: none; }
.edir { flex: 1; min-width: 0; }
.ebtns { display: flex; align-items: center; gap: 7px; }
.emsg { color: var(--bad); font-size: 11.5px; }

.githubbox { border-top: 1px solid var(--line); padding-top: 9px; display: flex; flex-direction: column; gap: 6px; }
.ghline { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ghname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink-mid); font-size: 12px; }
.ghname.bad, .bad { color: var(--bad); }
.ok-text { color: var(--good); }
.ghslug, .ghcommands { border: 1px solid var(--line-2); background: var(--surface-2); color: var(--ink);
  border-radius: 7px; font-size: 12px; padding: 5px 8px; }
.ghslug { flex: 1; min-width: 0; }
.ghcommands { resize: vertical; min-height: 50px; }
.ghcheck { color: var(--ink-mid); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.ghmeta { color: var(--ink-mid); font-size: 11.5px; display: flex; flex-wrap: wrap; gap: 4px; }
.ghactions { display: flex; justify-content: flex-end; gap: 7px; }

.routes { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rchip { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 999px;
  padding: 2px 10px; font-size: 11.5px; cursor: pointer; }
.rchip:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }

.cfoot { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 4px 11px; font-size: 12.5px; cursor: pointer; flex: none; }
.act:hover { color: var(--ink); border-color: var(--line-2); }
.act.pri { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.act:disabled { opacity: .5; cursor: default; }
</style>
