import 'reflect-metadata';
import { Circuit, JSONValue, AsFieldElements } from '../snarky.js';
import { Field, Bool } from './core.js';
import { Context } from './global-context.js';
import { HashInput } from './hash.js';
import { inCheckedComputation, snarkContext } from './proof_system.js';

// external API
export {
  Circuit,
  CircuitValue,
  prop,
  arrayProp,
  matrixProp,
  public_,
  circuitMain,
  circuitValue,
};

// internal API
export {
  AsFieldsExtended,
  AsFieldsAndAux,
  AnyConstructor,
  cloneCircuitValue,
  circuitValueEquals,
  circuitArray,
  memoizationContext,
  memoizeWitness,
  getBlindingValue,
  toConstant,
  witness,
};

type AnyConstructor = new (...args: any) => any;

type NonMethodKeys<T> = {
  [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];
type NonMethods<T> = Pick<T, NonMethodKeys<T>>;

abstract class CircuitValue {
  constructor(...props: any[]) {
    // if this is called with no arguments, do nothing, to support simple super() calls
    if (props.length === 0) return;

    let fields = this.constructor.prototype._fields;
    if (fields === undefined) return;
    if (props.length !== fields.length) {
      throw Error(
        `${this.constructor.name} constructor called with ${props.length} arguments, but expected ${fields.length}`
      );
    }
    for (let i = 0; i < fields.length; ++i) {
      let [key] = fields[i];
      (this as any)[key] = props[i];
    }
  }

  static fromObject<T extends AnyConstructor>(
    this: T,
    value: NonMethods<InstanceType<T>>
  ): InstanceType<T> {
    return Object.assign(Object.create(this.prototype), value);
  }

  static sizeInFields(): number {
    const fields: [string, any][] = (this as any).prototype._fields;
    return fields.reduce((acc, [_, typ]) => acc + typ.sizeInFields(), 0);
  }

  static toFields<T extends AnyConstructor>(
    this: T,
    v: InstanceType<T>
  ): Field[] {
    const res: Field[] = [];
    const fields = this.prototype._fields;
    if (fields === undefined || fields === null) {
      return res;
    }
    for (let i = 0, n = fields.length; i < n; ++i) {
      const [key, propType] = fields[i];
      const subElts: Field[] = propType.toFields((v as any)[key]);
      subElts.forEach((x) => res.push(x));
    }
    return res;
  }

  static toInput<T extends AnyConstructor>(
    this: T,
    v: InstanceType<T>
  ): HashInput {
    let input: HashInput = { fields: [], packed: [] };
    let fields = this.prototype._fields;
    if (fields === undefined) return input;
    for (let i = 0, n = fields.length; i < n; ++i) {
      let [key, type] = fields[i];
      if ('toInput' in type) {
        HashInput.append(input, type.toInput(v[key]));
        continue;
      }
      // as a fallback, use toFields on the type
      // TODO: this is problematic -- ignores if there's a toInput on a nested type
      // so, remove this? should every circuit value define toInput?
      let xs: Field[] = type.toFields(v[key]);
      input.fields!.push(...xs);
    }
    return input;
  }

  toFields(): Field[] {
    return (this.constructor as any).toFields(this);
  }

  toJSON(): JSONValue {
    return (this.constructor as any).toJSON(this);
  }

  toConstant(): this {
    return (this.constructor as any).toConstant(this);
  }

  equals(x: this) {
    return Circuit.equal(this, x);
  }

  assertEquals(x: this) {
    Circuit.assertEqual(this, x);
  }

  isConstant() {
    return this.toFields().every((x) => x.isConstant());
  }

  static ofFields<T extends AnyConstructor>(
    this: T,
    xs: Field[]
  ): InstanceType<T> {
    const fields: [string, any][] = (this as any).prototype._fields;
    if (xs.length < fields.length) {
      throw Error(
        `${this.name}.ofFields: Expected ${fields.length} field elements, got ${xs?.length}`
      );
    }
    let offset = 0;
    const props: any = {};
    for (let i = 0; i < fields.length; ++i) {
      const [key, propType] = fields[i];
      const propSize = propType.sizeInFields();
      const propVal = propType.ofFields(xs.slice(offset, offset + propSize));
      props[key] = propVal;
      offset += propSize;
    }
    return Object.assign(Object.create(this.prototype), props);
  }

  static check<T extends AnyConstructor>(this: T, v: InstanceType<T>) {
    const fields = (this as any).prototype._fields;
    if (fields === undefined || fields === null) {
      return;
    }
    for (let i = 0; i < fields.length; ++i) {
      const [key, propType] = fields[i];
      const value = (v as any)[key];
      if (propType.check === undefined)
        throw Error('bug: circuit value without .check()');
      propType.check(value);
    }
  }

  static toConstant<T extends AnyConstructor>(
    this: T,
    t: InstanceType<T>
  ): InstanceType<T> {
    const xs: Field[] = (this as any).toFields(t);
    return (this as any).ofFields(xs.map((x) => x.toConstant()));
  }

  static toJSON<T extends AnyConstructor>(
    this: T,
    v: InstanceType<T>
  ): JSONValue {
    const res: { [key: string]: JSONValue } = {};
    if ((this as any).prototype._fields !== undefined) {
      const fields: [string, any][] = (this as any).prototype._fields;
      fields.forEach(([key, propType]) => {
        res[key] = propType.toJSON((v as any)[key]);
      });
    }
    return res;
  }

  static fromJSON<T extends AnyConstructor>(
    this: T,
    value: JSONValue
  ): InstanceType<T> | null {
    const props: any = {};
    const fields: [string, any][] = (this as any).prototype._fields;

    switch (typeof value) {
      case 'object':
        if (value === null || Array.isArray(value)) {
          return null;
        }
        break;
      default:
        return null;
    }

    if (fields !== undefined) {
      for (let i = 0; i < fields.length; ++i) {
        const [key, propType] = fields[i];
        if (value[key] === undefined) {
          return null;
        } else {
          props[key] = propType.fromJSON(value[key]);
        }
      }
    }

    return Object.assign(Object.create(this.prototype), props);
  }
}

function prop(this: any, target: any, key: string) {
  const fieldType = Reflect.getMetadata('design:type', target, key);
  if (!target.hasOwnProperty('_fields')) {
    target._fields = [];
  }
  if (fieldType === undefined) {
  } else if (fieldType.toFields && fieldType.ofFields) {
    target._fields.push([key, fieldType]);
  } else {
    console.log(
      `warning: property ${key} missing field element conversion methods`
    );
  }
}

function circuitArray<T>(
  elementType: AsFieldElements<T> | AsFieldsExtended<T>,
  length: number
): AsFieldsExtended<T[]> {
  return {
    sizeInFields() {
      let elementLength = elementType.sizeInFields();
      return elementLength * length;
    },
    toFields(array: T[]) {
      return array.map((e) => elementType.toFields(e)).flat();
    },
    ofFields(fields: Field[]) {
      let array = [];
      let elementLength = elementType.sizeInFields();
      let n = elementLength * length;
      for (let i = 0; i < n; i += elementLength) {
        array.push(elementType.ofFields(fields.slice(i, i + elementLength)));
      }
      return array;
    },
    check(array: T[]) {
      for (let i = 0; i < length; i++) {
        (elementType as any).check(array[i]);
      }
    },
    toJSON(array) {
      if (!('toJSON' in elementType)) {
        throw Error('circuitArray.toJSON: element type has no toJSON method');
      }
      return array.map((v) => elementType.toJSON(v));
    },
    toInput(array) {
      if (!('toInput' in elementType)) {
        throw Error('circuitArray.toInput: element type has no toInput method');
      }
      return array.reduce(
        (curr, value) => HashInput.append(curr, elementType.toInput(value)),
        HashInput.empty
      );
    },
  };
}

function arrayProp<T>(elementType: AsFieldElements<T>, length: number) {
  return function (target: any, key: string) {
    if (!target.hasOwnProperty('_fields')) {
      target._fields = [];
    }
    target._fields.push([key, circuitArray(elementType, length)]);
  };
}

function matrixProp<T>(
  elementType: AsFieldElements<T>,
  nRows: number,
  nColumns: number
) {
  return function (target: any, key: string) {
    if (!target.hasOwnProperty('_fields')) {
      target._fields = [];
    }
    target._fields.push([
      key,
      circuitArray(circuitArray(elementType, nColumns), nRows),
    ]);
  };
}

function public_(target: any, _key: string | symbol, index: number) {
  // const fieldType = Reflect.getMetadata('design:paramtypes', target, key);

  if (target._public === undefined) {
    target._public = [];
  }
  target._public.push(index);
}

function typeOfArray(typs: Array<AsFieldElements<any>>): AsFieldElements<any> {
  return {
    sizeInFields: () => {
      return typs.reduce((acc, typ) => acc + typ.sizeInFields(), 0);
    },

    toFields: (t: Array<any>) => {
      if (t.length !== typs.length) {
        throw new Error(`typOfArray: Expected ${typs.length}, got ${t.length}`);
      }

      let res = [];
      for (let i = 0; i < t.length; ++i) {
        res.push(...typs[i].toFields(t[i]));
      }
      return res;
    },

    ofFields: (xs: Array<any>) => {
      let offset = 0;
      let res: Array<any> = [];
      typs.forEach((typ) => {
        const n = typ.sizeInFields();
        res.push(typ.ofFields(xs.slice(offset, offset + n)));
        offset += n;
      });
      return res;
    },

    check(xs: Array<any>) {
      typs.forEach((typ, i) => (typ as any).check(xs[i]));
    },
  };
}

function circuitMain(
  target: any,
  propertyName: string,
  _descriptor?: PropertyDescriptor
): any {
  const paramTypes = Reflect.getMetadata(
    'design:paramtypes',
    target,
    propertyName
  );
  const numArgs = paramTypes.length;

  const publicIndexSet: Set<number> = new Set(target._public);
  const witnessIndexSet: Set<number> = new Set();
  for (let i = 0; i < numArgs; ++i) {
    if (!publicIndexSet.has(i)) {
      witnessIndexSet.add(i);
    }
  }

  target.snarkyMain = (w: Array<any>, pub: Array<any>) => {
    let [, result] = snarkContext.runWith(
      { inCheckedComputation: true },
      () => {
        let args = [];
        for (let i = 0; i < numArgs; ++i) {
          args.push((publicIndexSet.has(i) ? pub : w).shift());
        }

        return target[propertyName].apply(target, args);
      }
    );
    return result;
  };

  target.snarkyWitnessTyp = typeOfArray(
    Array.from(witnessIndexSet).map((i) => paramTypes[i])
  );
  target.snarkyPublicTyp = typeOfArray(
    Array.from(publicIndexSet).map((i) => paramTypes[i])
  );
}

let primitives = new Set(['Field', 'Bool', 'Scalar', 'Group']);
let complexTypes = new Set(['object', 'function']);

type AsFieldsExtended<T> = AsFieldElements<T> & {
  toInput: (x: T) => { fields?: Field[]; packed?: [Field, number][] };
  toJSON: (x: T) => JSONValue;
};

// TODO properly type this at the interface
// create recursive type that describes JSON-like structures of circuit types
// TODO unit-test this
function circuitValue<T>(
  typeObj: any,
  options?: { customObjectKeys: string[] }
): AsFieldsExtended<T> {
  let objectKeys =
    typeof typeObj === 'object' && typeObj !== null
      ? options?.customObjectKeys ?? Object.keys(typeObj).sort()
      : [];

  function sizeInFields(typeObj: any): number {
    if (!complexTypes.has(typeof typeObj) || typeObj === null) return 0;
    if (Array.isArray(typeObj))
      return typeObj.map(sizeInFields).reduce((a, b) => a + b, 0);
    if ('sizeInFields' in typeObj) return typeObj.sizeInFields();
    return Object.values(typeObj)
      .map(sizeInFields)
      .reduce((a, b) => a + b, 0);
  }
  function toFields(typeObj: any, obj: any): Field[] {
    if (!complexTypes.has(typeof typeObj) || typeObj === null) return [];
    if (Array.isArray(typeObj))
      return typeObj.map((t, i) => toFields(t, obj[i])).flat();
    if ('toFields' in typeObj) return typeObj.toFields(obj);
    return objectKeys.map((k) => toFields(typeObj[k], obj[k])).flat();
  }
  function toInput(typeObj: any, obj: any): HashInput {
    if (!complexTypes.has(typeof typeObj) || typeObj === null) return {};
    if (Array.isArray(typeObj)) {
      return typeObj
        .map((t, i) => toInput(t, obj[i]))
        .reduce(HashInput.append, {});
    }
    if ('toInput' in typeObj) return typeObj.toInput(obj) as HashInput;
    if ('toFields' in typeObj) {
      return { fields: typeObj.toFields(obj) };
    }
    return objectKeys
      .map((k) => toInput(typeObj[k], obj[k]))
      .reduce(HashInput.append, {});
  }
  function toJSON(typeObj: any, obj: any): JSONValue {
    if (!complexTypes.has(typeof typeObj) || typeObj === null)
      return obj ?? null;
    if (Array.isArray(typeObj)) return typeObj.map((t, i) => toJSON(t, obj[i]));
    if ('toJSON' in typeObj) return typeObj.toJSON(obj);
    return Object.fromEntries(
      objectKeys.map((k) => [k, toJSON(typeObj[k], obj[k])])
    );
  }
  function ofFields(typeObj: any, fields: Field[]): any {
    if (!complexTypes.has(typeof typeObj) || typeObj === null) return null;
    if (Array.isArray(typeObj)) {
      let array = [];
      let offset = 0;
      for (let subObj of typeObj) {
        let size = sizeInFields(subObj);
        array.push(ofFields(subObj, fields.slice(offset, offset + size)));
        offset += size;
      }
      return array;
    }
    if ('ofFields' in typeObj) return typeObj.ofFields(fields);
    let values = ofFields(
      objectKeys.map((k) => typeObj[k]),
      fields
    );
    return Object.fromEntries(objectKeys.map((k, i) => [k, values[i]]));
  }
  function check(typeObj: any, obj: any): void {
    if (!complexTypes.has(typeof typeObj) || typeObj === null) return;
    if (Array.isArray(typeObj))
      return typeObj.forEach((t, i) => check(t, obj[i]));
    if ('check' in typeObj) return typeObj.check(obj);
    return objectKeys.forEach((k) => check(typeObj[k], obj[k]));
  }
  return {
    sizeInFields: () => sizeInFields(typeObj),
    toFields: (obj: T) => toFields(typeObj, obj),
    toInput: (obj: T) => toInput(typeObj, obj),
    toJSON: (obj: T) => toJSON(typeObj, obj),
    ofFields: (fields: Field[]) => ofFields(typeObj, fields) as T,
    check: (obj: T) => check(typeObj, obj),
  };
}

// FIXME: the logic in here to check for obj.constructor.name actually doesn't work
// something that works is Field.one.constructor === obj.constructor etc
function cloneCircuitValue<T>(obj: T): T {
  // primitive JS types and functions aren't cloned
  if (typeof obj !== 'object' || obj === null) return obj;

  // HACK: callbacks
  if (
    ['GenericArgument', 'Callback'].includes((obj as any).constructor?.name)
  ) {
    return obj;
  }

  // built-in JS datatypes with custom cloning strategies
  if (Array.isArray(obj)) return obj.map(cloneCircuitValue) as any as T;
  if (obj instanceof Set)
    return new Set([...obj].map(cloneCircuitValue)) as any as T;
  if (obj instanceof Map)
    return new Map(
      [...obj].map(([k, v]) => [k, cloneCircuitValue(v)])
    ) as any as T;
  if (ArrayBuffer.isView(obj)) return new (obj.constructor as any)(obj);

  // snarkyjs primitives aren't cloned
  if (primitives.has((obj as any).constructor.name)) return obj;

  // cloning strategy that works for plain objects AND classes whose constructor only assigns properties
  let propertyDescriptors: Record<string, PropertyDescriptor> = {};
  for (let [key, value] of Object.entries(obj)) {
    propertyDescriptors[key] = {
      value: cloneCircuitValue(value),
      writable: true,
      enumerable: true,
      configurable: true,
    };
  }
  return Object.create(Object.getPrototypeOf(obj), propertyDescriptors);
}

function circuitValueEquals<T>(a: T, b: T): boolean {
  // primitive JS types and functions are checked for exact equality
  if (typeof a !== 'object' || a === null) return a === b;

  // built-in JS datatypes with custom equality checks
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((a_, i) => circuitValueEquals(a_, b[i]))
    );
  }
  if (a instanceof Set) {
    return (
      b instanceof Set && a.size === b.size && [...a].every((a_) => b.has(a_))
    );
  }
  if (a instanceof Map) {
    return (
      b instanceof Map &&
      a.size === b.size &&
      [...a].every(([k, v]) => circuitValueEquals(v, b.get(k)))
    );
  }
  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    // typed array
    return (
      ArrayBuffer.isView(b) &&
      !(b instanceof DataView) &&
      circuitValueEquals([...(a as any)], [...(b as any)])
    );
  }

  // the two checks below cover snarkyjs primitives and CircuitValues
  // if we have an .equals method, try to use it
  if ('equals' in a && typeof (a as any).equals === 'function') {
    let isEqual = (a as any).equals(b).toBoolean();
    if (typeof isEqual === 'boolean') return isEqual;
    if (isEqual instanceof Bool) return isEqual.toBoolean();
  }
  // if we have a .toFields method, try to use it
  if (
    'toFields' in a &&
    typeof (a as any).toFields === 'function' &&
    'toFields' in b &&
    typeof (b as any).toFields === 'function'
  ) {
    let aFields = (a as any).toFields() as Field[];
    let bFields = (b as any).toFields() as Field[];
    return aFields.every((a, i) => a.equals(bFields[i]).toBoolean());
  }

  // equality test that works for plain objects AND classes whose constructor only assigns properties
  let aEntries = Object.entries(a as any).filter(([, v]) => v !== undefined);
  let bEntries = Object.entries(b as any).filter(([, v]) => v !== undefined);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(
    ([key, value]) => key in b && circuitValueEquals((b as any)[key], value)
  );
}

function toConstant<T>(type: AsFieldElements<T>, value: T): T {
  return type.ofFields(type.toFields(value).map((x) => x.toConstant()));
}

// TODO: move `Circuit` to JS entirely, this patching harms code discoverability
Circuit.array = circuitArray;

Circuit.switch = function <T, A extends AsFieldElements<T>>(
  mask: Bool[],
  type: A,
  values: T[]
): T {
  // picks the value at the index where mask is true
  let nValues = values.length;
  if (mask.length !== nValues)
    throw Error(
      `Circuit.switch: \`values\` and \`mask\` have different lengths (${values.length} vs. ${mask.length}), which is not allowed.`
    );
  let checkMask = () => {
    let nTrue = mask.filter((b) => b.toBoolean()).length;
    if (nTrue > 1) {
      throw Error(
        `Circuit.switch: \`mask\` must have 0 or 1 true element, found ${nTrue}.`
      );
    }
  };
  if (mask.every((b) => b.toField().isConstant())) checkMask();
  else Circuit.asProver(checkMask);
  let size = type.sizeInFields();
  let fields = Array(size).fill(Field.zero);
  for (let i = 0; i < nValues; i++) {
    let valueFields = type.toFields(values[i]);
    let maskField = mask[i].toField();
    for (let j = 0; j < size; j++) {
      let maybeField = valueFields[j].mul(maskField);
      fields[j] = fields[j].add(maybeField);
    }
  }
  return type.ofFields(fields);
};

Circuit.constraintSystem = function <T>(f: () => T) {
  let [, result] = snarkContext.runWith(
    { inAnalyze: true, inCheckedComputation: true },
    () => {
      let result: T;
      let { rows, digest, json } = (Circuit as any)._constraintSystem(() => {
        result = f();
      });
      return { rows, digest, result: result! };
    }
  );
  return result;
};

// TODO: very likely, this is how Circuit.witness should behave
function witness<T>(type: AsFieldElements<T>, compute: () => T) {
  return inCheckedComputation() ? Circuit.witness(type, compute) : compute();
}

let memoizationContext = Context.create<{
  memoized: Field[][];
  currentIndex: number;
  blindingValue: Field;
}>();

/**
 * Like Circuit.witness, but memoizes the witness during transaction construction
 * for reuse by the prover. This is needed to witness non-deterministic values.
 */
function memoizeWitness<T>(type: AsFieldElements<T>, compute: () => T) {
  return witness(type, () => {
    if (!memoizationContext.has()) return compute();
    let context = memoizationContext.get();
    let { memoized, currentIndex } = context;
    let currentValue = memoized[currentIndex];
    if (currentValue === undefined) {
      let value = compute();
      currentValue = type.toFields(value).map((x) => x.toConstant());
      memoized[currentIndex] = currentValue;
    }
    context.currentIndex += 1;
    return type.ofFields(currentValue);
  });
}

function getBlindingValue() {
  if (!memoizationContext.has()) return Field.random();
  let context = memoizationContext.get();
  if (context.blindingValue === undefined) {
    context.blindingValue = Field.random();
  }
  return context.blindingValue;
}

// "complex" circuit values which have auxiliary data, and have to be hashed

type AsFieldsAndAux<T, TJson> = {
  sizeInFields(): number;
  toFields(value: T): Field[];
  toAuxiliary(value?: T): any[];
  fromFields(fields: Field[], aux: any[]): T;
  toJSON(value: T): TJson;
  check(value: T): void;
  toInput(value: T): HashInput;
};

// convert from circuit values
function fromCircuitValue<T, A extends AsFieldsExtended<T>, TJson = JSONValue>(
  type: A
): AsFieldsAndAux<T, TJson> {
  return {
    sizeInFields() {
      return type.sizeInFields();
    },
    toFields(value) {
      return type.toFields(value);
    },
    toAuxiliary(_) {
      return [];
    },
    fromFields(fields) {
      let myFields: Field[] = [];
      let size = type.sizeInFields();
      for (let i = 0; i < size; i++) {
        myFields.push(fields.pop()!);
      }
      return type.ofFields(myFields);
    },
    check(value) {
      type.check(value);
    },
    toInput(value) {
      return type.toInput(value);
    },
    toJSON(value) {
      return type.toJSON(value) as any;
    },
  };
}

const AsFieldsAndAux = {
  fromCircuitValue,
};
