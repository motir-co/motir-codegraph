import { describe, expect, it } from 'vitest';

import { extract } from '../../src/extract/extract.js';
import { compileQuery } from '../../src/extract/runtime.js';
import type { Fact } from '../../src/extract/types.js';
import { languageForPath, listLanguages } from '../../src/indexer/registry.js';

describe('every registered language', () => {
  it.each(listLanguages().map((entry) => [entry.language, entry] as const))(
    '%s: its grammar loaded and its tags query compiles against it',
    (id, entry) => {
      expect(entry.grammar, id).toBeDefined();
      expect(() => compileQuery(entry), id).not.toThrow();
    },
  );
});

/** A fact, as one line: every field the sample pins except the range. */
function summary(fact: Fact): string {
  switch (fact.kind) {
    case 'definition':
      return `definition ${fact.definitionKind} ${fact.name}`;
    case 'import':
      return `import ${fact.moduleSpecifier} [${fact.importedNames.join(', ')}]`;
    case 'inheritance':
      return `inheritance ${fact.name} ${fact.relation} ${fact.parentName}`;
    case 'reference':
      return `reference ${fact.referenceKind} ${fact.name}`;
  }
}

/**
 * One small source per language, and the definitions, imports and inheritances
 * it yields, in text order. References come from each grammar's own tags
 * query (C's and C++'s carry none) and are not pinned here.
 */
const SAMPLES: readonly { id: string; path: string; source: string; facts: readonly string[] }[] = [
  {
    id: 'typescript',
    path: 'src/a.ts',
    source: `import Def, { a, b as c } from "./m";
import type { T } from './t';
import * as ns from 'ns';
class A extends B implements I, J { m(): void { f(); } }
interface K extends L, M {}
`,
    facts: [
      'import ./m [Def, a, b]',
      'import ./t [T]',
      'import ns []',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'inheritance A implements J',
      'definition method m',
      'definition interface K',
      'inheritance K extends L',
      'inheritance K extends M',
    ],
  },
  {
    id: 'tsx',
    path: 'src/a.tsx',
    source: `import { a } from "./m";
export class A extends B implements I {
  render() { return <div onClick={() => f()} />; }
}
`,
    facts: [
      'import ./m [a]',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'definition method render',
    ],
  },
  {
    id: 'javascript',
    path: 'src/a.js',
    source: `import Def, { a, b as c } from "./m";
import * as ns from 'ns';
const r = require('req');
class A extends B { m() { f(); } }
`,
    facts: [
      'import ./m [Def, a, b]',
      'import ns []',
      'import req []',
      'definition class A',
      'inheritance A extends B',
      'definition method m',
    ],
  },
  {
    id: 'python',
    path: 'a.py',
    source: `import os, a.b as ab
from x.y import z, w as v
from . import rel
class A(B, metaclass=M):
    def m(self): f()
`,
    facts: [
      'import os []',
      'import a.b []',
      'import x.y [z, w]',
      'import . [rel]',
      'definition class A',
      'inheritance A extends B',
      'definition function m',
    ],
  },
  {
    id: 'java',
    path: 'A.java',
    source: `package p;
import java.util.List;
import static java.lang.Math.max;
import java.io.*;
class A extends B implements I, J { void m() { f(); } }
interface K extends L, M {}
`,
    facts: [
      'import java.util.List [List]',
      'import java.lang.Math.max [max]',
      'import java.io []',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'inheritance A implements J',
      'definition method m',
      'definition interface K',
      'inheritance K extends L',
      'inheritance K extends M',
    ],
  },
  {
    id: 'kotlin',
    path: 'a.kt',
    source: `package p
import a.b.C
import a.b.D as E
import a.b.*
class A : B(), I {
  fun m() {
    f()
  }
}
interface K : L
object O : P
fun top() = 1
`,
    facts: [
      'import a.b.C [C]',
      'import a.b.D [D]',
      'import a.b []',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'definition method m',
      'definition interface K',
      'inheritance K extends L',
      'definition object O',
      'inheritance O implements P',
      'definition function top',
    ],
  },
  {
    id: 'scala',
    path: 'a.scala',
    source: `package p
import a.b.C
import a.b.{D, E => F}
class A extends B with I { def m = f() }
trait T extends U
object O extends P

import x.y._
class Z extends B with I with J
`,
    facts: [
      'definition module p',
      'import a.b.C [C]',
      'import a.b [D, E]',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'definition function m',
      'definition interface T',
      'inheritance T extends U',
      'definition object O',
      'inheritance O extends P',
      'import x.y []',
      'definition class Z',
      'inheritance Z extends B',
      'inheritance Z implements I',
      'inheritance Z implements J',
    ],
  },
  {
    id: 'go',
    path: 'a.go',
    source: `package p
import "fmt"
import (
  alias "a/b"
  "c/d"
)
type S struct { Base; x int }
type I interface { J; M() }
func (s S) M() { f() }
`,
    facts: [
      'import fmt []',
      'import a/b []',
      'import c/d []',
      'definition type S',
      'definition type I',
      'inheritance I extends J',
      'definition method M',
    ],
  },
  {
    id: 'c',
    path: 'a.c',
    source: `#include <stdio.h>
#include "local.h"
struct S { int x; };
int main(void) { f(); }
`,
    facts: [
      'import <stdio.h> []',
      'import local.h []',
      'definition class S',
      'definition function main',
    ],
  },
  {
    id: 'cpp',
    path: 'a.cpp',
    source: `#include <vector>
#include "a.hpp"
import std;
class A : public B, private C { void m() { f(); } };
struct D : E {};
`,
    facts: [
      'import <vector> []',
      'import a.hpp []',
      'definition class A',
      'inheritance A extends B',
      'inheritance A extends C',
      'definition function m',
      'definition class D',
      'inheritance D extends E',
    ],
  },
  {
    id: 'ruby',
    path: 'a.rb',
    source: `require 'json'
require_relative "lib/x"
class A < B
  include M
  def m; f(); end
end
module N; end
`,
    facts: [
      'import json []',
      'import lib/x []',
      'definition class A',
      'inheritance A extends B',
      'definition method m',
      'definition module N',
    ],
  },
  {
    id: 'csharp',
    path: 'a.cs',
    source: `using System;
using Alias = System.Text;
using static System.Math;
class A : B, I { void M() { F(); } }
interface K : L {}
`,
    facts: [
      'import System []',
      'import System.Text []',
      'import System.Math []',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'definition method M',
      'definition interface K',
      'inheritance K extends L',
    ],
  },
  {
    id: 'rust',
    path: 'a.rs',
    source: `use std::collections::HashMap;
use crate::a::{b, c as d};
use e::*;
trait T: U + V {}
struct S;
impl T for S { fn m(&self) { f(); } }
`,
    facts: [
      'import std::collections::HashMap [HashMap]',
      'import crate::a [b, c]',
      'import e []',
      'definition interface T',
      'inheritance T extends U',
      'inheritance T extends V',
      'definition class S',
      'inheritance S implements T',
      'definition method m',
    ],
  },
  {
    id: 'dart',
    path: 'a.dart',
    source: `import 'package:a/b.dart';
import 'c.dart' show D, E hide F;
export 'x.dart';
class A extends B with M implements I, J { void m() { f(); } }
`,
    facts: [
      'import package:a/b.dart []',
      'import c.dart [D, E]',
      'import x.dart []',
      'definition class A',
      'inheritance A extends B',
      'inheritance A implements I',
      'inheritance A implements J',
      'definition method m',
    ],
  },
  {
    id: 'php',
    path: 'a.php',
    source: `<?php
namespace N;
use A\\B;
use C\\{D, E as F};
require_once 'x.php';
class K extends L implements I, J { function m() { f(); } }
interface Q extends R {}
`,
    facts: [
      'definition module N',
      'import A\\B [B]',
      'import C [D, E]',
      'import x.php []',
      'definition class K',
      'inheritance K extends L',
      'inheritance K implements I',
      'inheritance K implements J',
      'definition function m',
      'definition interface Q',
      'inheritance Q extends R',
    ],
  },
  {
    id: 'elixir',
    path: 'a.ex',
    source: `defmodule A.B do
  alias C.D
  import E
  require F
  use G
  @behaviour H
  def m(x), do: f(x)
end
`,
    facts: [
      'definition module A.B',
      'import C.D []',
      'import E []',
      'import F []',
      'import G []',
      'inheritance A.B implements H',
      'definition function m',
    ],
  },
  {
    id: 'haskell',
    path: 'a.hs',
    source: `module A.B where
import Data.List (sort, nub)
import qualified Data.Map as M
class Eq a => Ord a where
  cmp :: a -> a -> Int
data T = T Int
instance Show T where
  show _ = f 1
g x = h x
`,
    facts: [
      'definition module A.B',
      'import Data.List [sort, nub]',
      'import Data.Map []',
      'definition interface Ord',
      'inheritance Ord extends Eq',
      'definition method cmp',
      'definition type T',
      'definition constructor T',
      'inheritance T implements Show',
      'definition function g',
    ],
  },
  {
    id: 'lua',
    path: 'a.lua',
    source: `local json = require("json")
local m = require "mod"
function M.f(a) g(a) end
local function h() end
`,
    facts: ['import json []', 'import mod []', 'definition function f', 'definition function h'],
  },
  {
    id: 'solidity',
    path: 'a.sol',
    source: `pragma solidity ^0.8.0;
import "./A.sol";
import {B, C as D} from "./E.sol";
interface I {}
contract K is L, I { function m() public { f(); } }
`,
    facts: [
      'import ./A.sol []',
      'import ./E.sol [B, C]',
      'definition interface I',
      'definition class K',
      'inheritance K extends L',
      'inheritance K extends I',
      'definition method m',
    ],
  },
];

describe('each language’s captures, over a sample of its own', () => {
  it('covers every registered language', () => {
    expect(SAMPLES.map((s) => s.id).sort()).toEqual(listLanguages().map((e) => e.language));
  });

  it.each(SAMPLES.map((s) => [s.id, s] as const))('%s', (id, sample) => {
    const entry = languageForPath(sample.path);
    expect(entry?.language, sample.path).toBe(id);
    if (entry === null) return;
    const { facts, parsedWithErrors } = extract(entry, sample.source);
    expect(parsedWithErrors, id).toBe(false);
    expect(facts.filter((f) => f.kind !== 'reference').map(summary), id).toEqual(sample.facts);
    for (const fact of facts) {
      expect(fact.language).toBe(id);
      expect(fact.extractorVersion).toBe(entry.extractorVersion);
    }
  });
});
