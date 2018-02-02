import { handleActions } from 'redux-actions'
import reduceReducers from 'reduce-reducers'
import _ from 'lodash'
import nanoid from 'nanoid'

import { hashCode } from '~/util'

import {
  requestFlows,
  requestSaveFlows,
  receiveSaveFlows,
  receiveFlows,
  switchFlow,
  updateFlow,
  handleRefreshFlowLinks,
  renameFlow,
  updateFlowNode,
  switchFlowNode,
  setDiagramAction,
  createFlowNode,
  copyFlowNode,
  pasteFlowNode,
  createFlow,
  deleteFlow,
  duplicateFlow,
  removeFlowNode,
  handleFlowEditorUndo,
  handleFlowEditorRedo,
  linkFlowNodes,
  insertNewSkill,
  insertNewSkillNode,
  updateSkill
} from '~/actions'

const MAX_UNDO_STACK_SIZE = 25

const defaultState = {
  flowsByName: {},
  fetchingFlows: false,
  currentFlow: null,
  currentFlowNode: null,
  currentDiagramAction: null,
  currentSnapshot: null,
  undoStack: [],
  redoStack: [],
  nodeInBuffer: null
}

const applySnapshot = (state, snapshot) => ({
  ...state,
  currentFlow: snapshot.currentFlow,
  currentFlowNode: snapshot.currentFlowNode,
  flowsByName: snapshot.flowsByName
})

const findNodesThatReferenceFlow = (state, flowName) =>
  _.flatten(_.values(state.flowsByName).map(flow => flow.nodes))
    .filter(node => node.flow === flowName || _.find(node.next, { node: flowName }))
    .map(node => node.id)

const computeFlowsHash = state => {
  const hashAction = (hash, action) => {
    if (_.isArray(action)) {
      action.forEach(c => {
        if (_.isString(c)) {
          hash += c
        } else {
          hash += c.node
          hash += c.condition
        }
      })
    } else {
      hash += 'null'
    }

    return hash
  }

  return _.values(state.flowsByName).reduce((obj, curr) => {
    if (!curr) {
      return obj
    }

    let buff = ''
    buff += curr.name
    buff += curr.startNode

    if (curr.catchAll) {
      buff = hashAction(buff, curr.catchAll.onReceive)
      buff = hashAction(buff, curr.catchAll.onEnter)
      buff = hashAction(buff, curr.catchAll.next)
    }

    _.orderBy(curr.nodes, 'id').forEach(node => {
      buff = hashAction(buff, node.onReceive)
      buff = hashAction(buff, node.onEnter)
      buff = hashAction(buff, node.next)
      buff += node.id
      buff += node.flow
      buff += node.type
      buff += node.name
      buff += node.x
      buff += node.y
    })

    _.orderBy(curr.links, l => l.source + l.target).forEach(link => {
      buff += link.source
      buff += link.target
      link.points &&
        link.points.forEach(p => {
          buff += p.x
          buff += p.y
        })
    })

    obj[curr.name] = hashCode(buff)
    return obj
  }, {})
}

const updateCurrentHash = state => ({ ...state, currentHashes: computeFlowsHash(state) })

const createSnapshot = state => _.pick(state, ['currentFlow', 'currentFlowNode', 'flowsByName'])

const recordUndoStack = state => ({
  ...state,
  undoStack: [createSnapshot(state), ..._.take(state.undoStack, MAX_UNDO_STACK_SIZE - 1)],
  redoStack: []
})

const recordCurrentSnapshot = state => ({ ...state, currentSnapshot: createSnapshot(state) })

const popHistory = stackName => state => {
  const oppositeStack = stackName === 'undoStack' ? 'redoStack' : 'undoStack'
  if (state[stackName].length === 0) {
    return state
  }
  return {
    ...applySnapshot(state, state[stackName][0]),
    [stackName]: state[stackName].slice(1),
    [oppositeStack]: [state.currentSnapshot, ...state[oppositeStack]]
  }
}

const copyName = (siblingNames, nameToCopy) => {
  const copies = siblingNames.filter(name => name.startsWith(`${nameToCopy}-copy`))

  if (!copies.length) {
    return `${nameToCopy}-copy`
  }

  let i = 1
  while (true) {
    if (!copies.find(name => name === `${nameToCopy}-copy-${i}`)) {
      return `${nameToCopy}-copy-${i}`
    } else {
      i += 1
    }
  }
}

const doRenameFlow = ({ flow, name, flows }) =>
  flows.reduce((obj, f) => {
    if (f.name === flow) {
      f.name = name
      f.location = name
    }

    if (f.nodes) {
      let json = JSON.stringify(f.nodes)
      json = json.replace(flow, name)
      f.nodes = JSON.parse(json)
    }

    obj[f.name] = f

    return obj
  }, {})

const doCreateNewFlow = name => ({
  version: '0.1',
  name: name,
  location: name,
  startNode: 'entry',
  catchAll: {},
  links: [],
  nodes: [
    {
      id: nanoid(),
      name: 'entry',
      onEnter: [],
      onReceive: null,
      next: [],
      x: 100,
      y: 100
    }
  ]
})

// *****
// Reducer that deals with non-recordable (no snapshot taking)
// *****

let reducer = handleActions(
  {
    [requestFlows]: state => ({
      ...state,
      fetchingFlows: true
    }),

    [receiveFlows]: (state, { payload }) => {
      const flows = _.keys(payload).filter(key => !payload[key].skillData)
      const defaultFlow = _.keys(payload).includes('main.flow.json') ? 'main.flow.json' : _.first(flows)
      return {
        ...state,
        fetchingFlows: false,
        flowsByName: payload,
        currentFlow: state.currentFlow || defaultFlow
      }
    },

    [requestSaveFlows]: state => ({
      ...state,
      savingFlows: true
    }),

    [receiveSaveFlows]: state => ({
      ...state,
      savingFlows: false
    }),

    [switchFlowNode]: (state, { payload }) => ({
      ...state,
      currentFlowNode: payload
    }),

    [switchFlow]: (state, { payload }) => {
      return {
        ...state,
        currentFlowNode: null,
        currentFlow: payload
      }
    },

    [setDiagramAction]: (state, { payload }) => ({
      ...state,
      currentDiagramAction: payload
    }),

    [handleRefreshFlowLinks]: state => ({
      ...state,
      flowsByName: {
        ...state.flowsByName,
        [state.currentFlow]: {
          ...state.flowsByName[state.currentFlow],
          nodes: state.flowsByName[state.currentFlow].nodes.map(node => ({ ...node, lastModified: new Date() }))
        }
      }
    })
  },
  defaultState
)

// *****
// Reducer that creates snapshots of the flows (for undo / redo)
// *****

reducer = reduceReducers(
  reducer,
  handleActions(
    {
      [updateFlow]: recordUndoStack,
      [renameFlow]: recordUndoStack,
      [updateFlowNode]: recordUndoStack,
      [createFlowNode]: recordUndoStack,
      [linkFlowNodes]: recordUndoStack,
      [createFlow]: recordUndoStack,
      [deleteFlow]: recordUndoStack,
      [duplicateFlow]: recordUndoStack,
      [removeFlowNode]: recordUndoStack,
      [insertNewSkill]: recordUndoStack,
      [insertNewSkillNode]: recordUndoStack,
      [updateSkill]: recordUndoStack,
      [handleFlowEditorUndo]: popHistory('undoStack'),
      [handleFlowEditorRedo]: popHistory('redoStack')
    },
    defaultState
  )
)

reducer = reduceReducers(
  reducer,
  handleActions(
    {
      [renameFlow]: (state, { payload }) => ({
        ...state,
        flowsByName: doRenameFlow({
          flow: state.currentFlow,
          name: payload,
          flows: _.values(state.flowsByName)
        }),
        currentFlow: payload
      }),

      [updateFlow]: (state, { payload }) => {
        const currentFlow = state.flowsByName[state.currentFlow]
        const nodes = !payload.links
          ? currentFlow.nodes
          : currentFlow.nodes.map(node => {
              const nodeLinks = payload.links.filter(link => link.source === node.id)
              const next = node.next.map((value, index) => {
                const link = nodeLinks.find(link => Number(link.sourcePort.replace('out', '')) === index)
                const targetNode = _.find(currentFlow.nodes, { id: (link || {}).target })
                let remapNode = ''

                if (value.node.includes('.flow.json') || value.node === 'END' || value.node.startsWith('#')) {
                  remapNode = value.node
                }

                return { ...value, node: (targetNode && targetNode.name) || remapNode }
              })

              return { ...node, next, lastModified: new Date() }
            })

        const links = (payload.links || currentFlow.links).map(link => ({
          ...link,
          points: link.points.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }))
        }))

        return {
          ...state,
          flowsByName: {
            ...state.flowsByName,
            [state.currentFlow]: { ...currentFlow, nodes, ...payload, links }
          }
        }
      },

      [createFlow]: (state, { payload: name }) => ({
        ...state,
        flowsByName: {
          ...state.flowsByName,
          [name]: doCreateNewFlow(name)
        },
        currentFlow: name,
        currentFlowNode: null
      }),

      [deleteFlow]: (state, { payload: name }) => ({
        ...state,
        currentFlow: state.currentFlow === name ? null : state.currentFlow,
        currentFlowNode: state.currentFlow === name ? null : state.currentFlowNode,
        flowsByName: _.omit(state.flowsByName, name)
      }),

      // Inserting a new skill essentially:
      // 1. creates a new flow
      // 2. creates a new "skill" node
      // 3. puts that new node in the "insert buffer", waiting for user to place it on the canvas
      [insertNewSkill]: (state, { payload }) => {
        const skillId = payload.skillId.replace(/^botpress-skill-/i, '')
        const flowRandomId = nanoid(5)
        const flowName = `skills/${skillId}-${flowRandomId}.flow.json`

        const newFlow = Object.assign({}, payload.generatedFlow, {
          skillData: payload.data,
          name: flowName,
          location: flowName
        })

        const newNode = {
          id: 'skill-' + flowRandomId,
          type: 'skill-call',
          skill: skillId,
          name: `${skillId}-${flowRandomId}`,
          flow: flowName,
          next: payload.transitions || [],
          onEnter: null,
          onReceive: null
        }

        return {
          ...state,
          currentDiagramAction: 'insert_skill',
          nodeInBuffer: newNode,
          flowsByName: {
            ...state.flowsByName,
            [newFlow.name]: newFlow
          }
        }
      },

      [updateSkill]: (state, { payload }) => {
        const modifiedFlow = Object.assign({}, state.flowsByName[payload.editFlowName], payload.generatedFlow, {
          skillData: payload.data,
          name: payload.editFlowName,
          location: payload.editFlowName
        })

        const nodes = state.flowsByName[state.currentFlow].nodes.map(node => {
          if (node.id !== payload.editNodeId) {
            return node
          }

          return Object.assign({}, node, {
            next: payload.transitions
          })
        })

        return {
          ...state,
          flowsByName: {
            ...state.flowsByName,
            [payload.editFlowName]: modifiedFlow,
            [state.currentFlow]: {
              ...state.flowsByName[state.currentFlow],
              nodes: nodes
            }
          }
        }
      },

      [insertNewSkillNode]: (state, { payload }) => ({
        ...state,
        flowsByName: {
          ...state.flowsByName,
          [state.currentFlow]: {
            ...state.flowsByName[state.currentFlow],
            nodes: [
              ...state.flowsByName[state.currentFlow].nodes,
              _.merge(state.nodeInBuffer, _.pick(payload, ['x', 'y']))
            ]
          }
        }
      }),

      [duplicateFlow]: (state, { payload: { flowNameToDuplicate, name } }) => {
        return {
          ...state,
          flowsByName: {
            ...state.flowsByName,
            [name]: {
              ...state.flowsByName[flowNameToDuplicate],
              name,
              location: name,
              nodes: state.flowsByName[flowNameToDuplicate].nodes.map(node => ({
                ...node,
                id: nanoid()
              }))
            }
          },
          currentFlow: name,
          currentFlowNode: null
        }
      },

      [updateFlowNode]: (state, { payload }) => {
        const currentFlow = state.flowsByName[state.currentFlow]
        const currentNode = _.find(state.flowsByName[state.currentFlow].nodes, { id: state.currentFlowNode })
        const needsUpdate = name => name === (currentNode || {}).name && payload.name
        return {
          ...state,
          flowsByName: {
            ...state.flowsByName,
            [state.currentFlow]: {
              ...currentFlow,
              startNode: needsUpdate(currentFlow.startNode) ? payload.name : currentFlow.startNode,
              nodes: currentFlow.nodes.map(node => {
                if (node.id !== state.currentFlowNode) {
                  return {
                    ...node,
                    next: node.next.map(transition => ({
                      ...transition,
                      node: needsUpdate(transition.node) ? payload.name : transition.node
                    }))
                  }
                }

                return { ...node, ...payload, lastModified: new Date() }
              })
            }
          }
        }
      },

      [removeFlowNode]: (state, { payload }) => {
        const flowsToRemove = []
        const nodeToRemove = _.find(state.flowsByName[state.currentFlow].nodes, { id: payload })

        if (nodeToRemove.type === 'skill-call') {
          if (findNodesThatReferenceFlow(state, nodeToRemove.flow).length <= 1) {
            // Remove the skill flow if that was the only node referencing it
            flowsToRemove.push(nodeToRemove.flow)
          }
        }

        return {
          ...state,
          flowsByName: {
            ..._.omit(state.flowsByName, flowsToRemove),
            [state.currentFlow]: {
              ...state.flowsByName[state.currentFlow],
              nodes: state.flowsByName[state.currentFlow].nodes.filter(node => node.id !== payload)
            }
          }
        }
      },

      [linkFlowNodes]: (state, { payload }) => {
        const flow = state.flowsByName[state.currentFlow]

        const nodes = flow.nodes.map(node => {
          if (node.id !== payload.node) {
            return node
          }

          const clone = Object.assign({}, node)
          clone.next[payload.index].node = payload.target

          return clone
        })

        return {
          ...state,
          flowsByName: {
            ...state.flowsByName,
            [state.currentFlow]: {
              ...flow,
              nodes: nodes
            }
          }
        }
      },

      [copyFlowNode]: state => ({
        ...state,
        nodeInBuffer: { ..._.find(state.flowsByName[state.currentFlow].nodes, { id: state.currentFlowNode }) }
      }),

      [pasteFlowNode]: state => {
        const currentFlow = state.flowsByName[state.currentFlow]
        const newNodeId = nanoid()
        return {
          ...state,
          currentFlowNode: newNodeId,
          nodeInBuffer: null,
          flowsByName: {
            ...state.flowsByName,
            [state.currentFlow]: {
              ...currentFlow,
              nodes: [
                ...currentFlow.nodes,
                {
                  ...state.nodeInBuffer,
                  id: newNodeId,
                  name: copyName(currentFlow.nodes.map(({ name }) => name), state.nodeInBuffer.name),
                  lastModified: new Date(),
                  x: 0,
                  y: 0
                }
              ]
            }
          }
        }
      },

      [createFlowNode]: (state, { payload }) => ({
        ...state,
        flowsByName: {
          ...state.flowsByName,
          [state.currentFlow]: {
            ...state.flowsByName[state.currentFlow],
            nodes: [
              ...state.flowsByName[state.currentFlow].nodes,
              _.merge(
                {
                  id: nanoid(),
                  name: `node-${nanoid(4)}`,
                  x: 0,
                  y: 0,
                  next: [],
                  onEnter: [],
                  onReceive: null
                },
                payload
              )
            ]
          }
        }
      })
    },
    defaultState
  )
)

// *****
// Reducer that creates the 'initial hash' of flows (for dirty detection)
// Resets the 'dirty' state when a flow is saved
// *****

reducer = reduceReducers(
  reducer,
  handleActions(
    {
      [receiveFlows]: state => {
        const hashes = computeFlowsHash(state)
        return { ...state, currentHashes: hashes, initialHashes: hashes }
      },

      [receiveSaveFlows]: state => {
        const hashes = computeFlowsHash(state)
        return { ...state, currentHashes: hashes, initialHashes: hashes }
      },

      [updateFlow]: updateCurrentHash,
      [renameFlow]: updateCurrentHash,
      [linkFlowNodes]: updateCurrentHash,
      [updateFlowNode]: updateCurrentHash,

      [createFlowNode]: updateCurrentHash,
      [createFlow]: updateCurrentHash,
      [deleteFlow]: updateCurrentHash,
      [duplicateFlow]: updateCurrentHash,
      [removeFlowNode]: updateCurrentHash,
      [insertNewSkillNode]: updateCurrentHash,
      [updateSkill]: updateCurrentHash
    },
    defaultState
  )
)

// *****
// Reducer that creates snapshots of current state of the flows (for redo)
// *****

reducer = reduceReducers(
  reducer,
  handleActions(
    {
      [updateFlow]: recordCurrentSnapshot,
      [renameFlow]: recordCurrentSnapshot,
      [updateFlowNode]: recordCurrentSnapshot,
      [createFlowNode]: recordCurrentSnapshot,
      [linkFlowNodes]: recordCurrentSnapshot,
      [createFlow]: recordCurrentSnapshot,
      [deleteFlow]: recordCurrentSnapshot,
      [duplicateFlow]: recordCurrentSnapshot,
      [removeFlowNode]: recordCurrentSnapshot,
      [insertNewSkill]: recordCurrentSnapshot,
      [insertNewSkillNode]: recordCurrentSnapshot,
      [updateSkill]: recordCurrentSnapshot,
      [handleFlowEditorUndo]: recordCurrentSnapshot,
      [handleFlowEditorRedo]: recordCurrentSnapshot
    },
    defaultState
  )
)

export default reducer
