export const ALL_BOARDS=Object.freeze(['A','B','C','D','E']);
const frozenList=items=>Object.freeze([...items]);
function layout(capacity,boards,pairs,master='C'){
  return Object.freeze({capacity,boards:frozenList(boards),doorBanks:frozenList(boards),master,
    adjacentSlavePairs:Object.freeze(pairs.map(frozenList))});
}

export const LAYOUTS=Object.freeze({
  '80':layout('80',ALL_BOARDS,[['A','B'],['D','E']]),
  '64':layout('64',['A','B','C','D'],[['A','B']]),
  '32':layout('32',['A','B'],[],'B'),
});
const NONE=Object.freeze([]);

// Only explicitly confirmed capacities have maps.
export function layoutForCapacity(capacity){
  return typeof capacity==='string'&&Object.hasOwn(LAYOUTS,capacity)?LAYOUTS[capacity]:null;
}

// Older sessions had no capacity field and used A–E. Preserve that interpretation
// for reading their evidence; an explicitly unknown capacity never inherits it.
function capacityOf(sessionOrCapacity){
  let capacity=sessionOrCapacity;
  if(sessionOrCapacity!==null&&typeof sessionOrCapacity==='object'&&!Array.isArray(sessionOrCapacity))capacity=sessionOrCapacity.details?.lockerCapacity;
  return capacity;
}
export function boardsFor(sessionOrCapacity){
  const capacity=capacityOf(sessionOrCapacity);
  if(capacity===undefined||capacity==='')return LAYOUTS['80'].boards;
  return layoutForCapacity(capacity)?.boards??NONE;
}

export function masterFor(sessionOrCapacity){
  const capacity=capacityOf(sessionOrCapacity);
  if(capacity===undefined||capacity==='')return LAYOUTS['80'].master;
  return layoutForCapacity(capacity)?.master??null;
}
