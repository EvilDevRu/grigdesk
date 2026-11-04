import { InboxRefCodec } from '../../../server/src/lib/inbox/identity.ts';
import { InboxTaskService } from '../../../server/src/lib/inbox/taskService.ts';

export const REVISION = `v1_${'a'.repeat(43)}`;

/**
 * Канальная фикстура сохраняет настоящий InboxTaskService и opaque refs.
 * Реальный tracker facade внедряется снаружи, удерживается только подготовка списка проектов.
 */
export function inboxConsumerFixture({ b24, prepare = async () => {} }) {
  const accountRef = 'acc_inbox_tracker_fixture';
  const codec = new InboxRefCodec({ channel: 'github', accountRef });
  const itemRef = codec.item('bundle-501');
  const messageRef = codec.message('101', '501');
  const calls = {
    decide: [],
    resolve: 0,
    released: 0
  };
  const message = {
    schema: 1,
    channel: 'github',
    accountRef,
    source: {
      id: '101',
      title: 'owner/repo',
      threadId: '501'
    },
    id: '501',
    parentId: null,
    groupId: null,
    occurredAt: 1_800_000_000,
    editedAt: null,
    author: { id: '7', name: 'Автор' },
    text: 'Ошибка в приложении',
    attachments: [],
    service: false,
    messageRef,
    decision: null,
  };
  const item = {
    ref: itemRef,
    revision: REVISION,
    channel: 'github',
    channelLabel: 'GitHub',
    activationEpoch: 1,
    localBundleId: 'bundle-501',
    source: message.source,
    sourceUrl: 'https://github.com/owner/repo/issues/1',
    firstAt: message.occurredAt,
    lastAt: message.occurredAt,
    cold: true,
    status: 'new',
    decision: null,
    messages: [message],
    attachments: [],
    policy: {
      scopeId: 'repository-101',
      project: 'grigdesk',
      kind: 'bug',
      b24: {
        groupId: 77,
        responsibleId: 12,
        priority: 2
      },
      autoTask: {
        enabled: false,
        minConfidence: 0.7,
        maxPerDay: 10
      },
      scopeRef: codec.scope('repository-101'),
    },
    draft: {
      title: 'Ошибка',
      description: message.text,
      attachments: [],
      source: { title: 'owner/repo', url: 'https://github.com/owner/repo/issues/1' },
      truncated: false,
    },
  };
  const coordinator = {
    async resolveItem() {
      calls.resolve += 1;

      return {
        channel: { id: 'github', label: 'GitHub' },
        channelState: {
          connection: 'connected',
          participation: 'active',
          readOnly: false
        },
        accountRef,
        generation: 1,
        item: structuredClone(item),
        refCodec: codec,
        context: {
          isCurrent: async () => true,
          sourceUrl: () => item.sourceUrl,
          materializeAttachments: async () => ({ files: [], skipped: [] }),
          inboxState: {
            async decide(args) {
              calls.decide.push(args);

              return {
                decisionId: 'decision_fixture',
                version: 1,
                status: 'tasked',
                taskId: '43'
              };
            },
          },
        },
        async release() {
          calls.released += 1;
        },
      };
    },
  };
  const service = new InboxTaskService({
    coordinator,
    tracker: b24,
    listProjects: async () => {
      await prepare();

      return ['grigdesk'];
    },
    attachmentAnalyzer: null,
    attachmentPolicy: () => ({}),
    taskUrlFor: (id) => b24.sourceUrl(id),
    isEnabled: async () => true,
    onChanged: () => {},
    now: () => 2000,
    log: { warn() {}, error() {} },
  });

  return {
    service,
    calls,
    itemRef,
    messageRef
  };
}
