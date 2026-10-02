/**
 * The Execution Diagram's view state in the panel model: the toolbar overrides and the scope
 * toggles, what a new run and new settings clear, and the hit list's arrival.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_VIEW, DEFAULT_SETTINGS, initialState, reduce, type PanelState } from '../../../webview/model';
import { zoomGraph } from './zoomFixture';

function seeded(): PanelState {
  let s = initialState();
  s = reduce(s, { type: 'host', message: { type: 'init', theme: 'dark', settings: DEFAULT_SETTINGS, sessionName: 'main.py' } });
  return reduce(s, { type: 'host', message: { type: 'executionGraph', graph: zoomGraph() } });
}

describe('graph view state', () => {
  it('starts on the story tab following the settings, toggles scopes, and clears the toggles on a new run only', () => {
    let s = seeded();
    expect(s.graphView).toEqual({ ...DEFAULT_GRAPH_VIEW, runId: 'r1' });
    s = reduce(s, { type: 'graphToggleScope', nodeId: 'n2' });
    s = reduce(s, { type: 'graphToggleScope', nodeId: 'n0' });
    expect(s.graphView.toggled).toEqual(['n2', 'n0']);
    s = reduce(s, { type: 'graphToggleScope', nodeId: 'n2' });
    expect(s.graphView.toggled).toEqual(['n0']);
    s = reduce(s, { type: 'graphView', patch: { base: 'open', toggled: [], dataEdges: true, left: 'walkthrough' } });
    expect(s.graphView).toEqual({ runId: 'r1', base: 'open', toggled: [], dataEdges: true, left: 'walkthrough' });
    s = reduce(s, { type: 'graphToggleScope', nodeId: 'n1' });
    // a resend for the same run (a package unrolled) keeps everything
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: zoomGraph({ expanded: ['libq'] }) } });
    expect(s.graphView.toggled).toEqual(['n1']);
    // a new run drops the toggles and keeps the overrides and the tab
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: zoomGraph({ runId: 'r2' }) } });
    expect(s.graphView).toEqual({ runId: 'r2', base: 'open', toggled: [], dataEdges: true, left: 'walkthrough' });
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: null } });
    expect(s.graphView.runId).toBeNull();
    expect(s.graphView.base).toBe('open');
  });
  it('drops the overrides when the diagram settings change, and keeps them when other settings do', () => {
    let s = seeded();
    s = reduce(s, { type: 'graphView', patch: { base: 'open', dataEdges: true } });
    s = reduce(s, { type: 'host', message: { type: 'settings', settings: { ...DEFAULT_SETTINGS, autoLog: true } } });
    expect(s.graphView.base).toBe('open');
    expect(s.graphView.dataEdges).toBe(true);
    s = reduce(s, { type: 'host', message: { type: 'settings', settings: { ...DEFAULT_SETTINGS, diagramDetail: 'statements' } } });
    expect(s.settings.diagramDetail).toBe('statements');
    expect(s.graphView.base).toBeNull();
    expect(s.graphView.dataEdges).toBeNull();
    s = reduce(s, { type: 'graphView', patch: { dataEdges: true } });
    s = reduce(s, { type: 'host', message: { type: 'init', theme: 'dark', settings: { ...DEFAULT_SETTINGS, diagramDetail: 'statements', diagramDataEdges: true }, sessionName: 'main.py' } });
    expect(s.graphView.dataEdges).toBeNull();
  });
  it('keeps the hits of the current run only', () => {
    let s = seeded();
    s = reduce(s, { type: 'host', message: { type: 'executionGraph.hits', runId: 'r0', nodeId: 'n7', total: 1, steps: [19], values: ['12'] } });
    expect(s.graphHits).toBeNull();
    s = reduce(s, { type: 'host', message: { type: 'executionGraph.hits', runId: 'r1', nodeId: 'n7', total: 1, steps: [19], values: ['12'] } });
    expect(s.graphHits).toEqual({ runId: 'r1', nodeId: 'n7', total: 1, steps: [19], values: ['12'] });
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: zoomGraph({ expanded: ['libq'] }) } });
    expect(s.graphHits?.nodeId).toBe('n7');
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: zoomGraph({ runId: 'r2' }) } });
    expect(s.graphHits).toBeNull();
  });
});
