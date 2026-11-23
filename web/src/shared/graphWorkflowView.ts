import type { WorkflowRunGraph } from '../../../shared/pipeline/graphWorkflowContracts.ts';
import type { FactoryGraphData } from '../../../shared/pipeline/factoryGraphContracts.ts';

const graphMarks = {
  pending: 'pending',
  ready: 'pending',
  running: 'run',
  waiting: 'wait',
  done: 'done',
  skipped: 'skip',
  failed: 'fail',
  blocked: 'fail',
} as const;

/**
 * Показывает группу или её фактических детей в том же SVG.
 * Позиции закреплены номерами добавления; обновление статуса не двигает старые вершины.
 */
export function workflowGraph(run: WorkflowRunGraph, expanded: ReadonlySet<string>,
  formatGroup: (node: WorkflowRunGraph['nodes'][number]) => string): FactoryGraphData {
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  const graph: FactoryGraphData = {
    pos: Object.create(null) as FactoryGraphData['pos'],
    nodes: Object.create(null) as FactoryGraphData['nodes'],
    edges: [],
    statuses: Object.create(null) as NonNullable<FactoryGraphData['statuses']>,
    nodeOrigins: Object.create(null) as NonNullable<FactoryGraphData['nodeOrigins']>,
    daemonAlive: run.status === 'running',
  };
  const visible = (id: string): boolean => {
    const node = byId.get(id);

    return !!node && (!node.parent || expanded.has(node.parent) && visible(node.parent));
  };

  for (const node of run.nodes) {
    if (!visible(node.id)) {
      continue;
    }

    const group = ['forEach', 'call', 'repeat'].includes(node.kind);
    const kind = node.kind === 'approval' ? 'human' :
      node.kind === 'agent' || node.kind === 'meetingTasks' ? 'agent' : 'code';

    graph.nodes[node.id] = [kind, node.title, group ? formatGroup(node) : ''];
    graph.nodeOrigins![node.id] = {
      scope: 'route',
      originId: node.id,
      executable: true,
    };
    graph.statuses![node.id] = graphMarks[node.status];
    graph.pos[node.id] = [110 + (node.id.split('.').length - 1) * 100, 78 + node.slot * 150];
  }

  for (const node of run.nodes) {
    if (!graph.pos[node.id]) {
      continue;
    }

    const after = node.after.length ? node.after : node.parent ? [node.parent] : [];

    for (const id of after) {
      const dependency = byId.get(id);
      const outputs = id !== node.parent && expanded.has(id) ? dependency?.outputs?.filter(visible) : [];
      const sources = outputs?.length ? outputs : [id];

      for (const source of sources) {
        if (source !== node.id && graph.pos[source]) {
          graph.edges.push([source, node.id, '', 'pass', '']);
        }
      }
    }
  }

  return graph;
}