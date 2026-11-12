import { describe, expect, it } from 'vitest';
import { DESIGN_MODES, isDesignMode, parseDesignModeArgs, pickLetter } from '../src/designModes';

describe('design mode parsing', () => {
  it('lists the supported modes', () => {
    expect(DESIGN_MODES).toEqual(['wireframe', 'states', 'variations', 'pick', 'spec', 'storyboard', 'report']);
    expect(isDesignMode('states')).toBe(true);
    expect(isDesignMode('States')).toBe(false);
    expect(isDesignMode('foo')).toBe(false);
    expect(isDesignMode(undefined)).toBe(false);
  });

  it.each([
    ['wireframe: a billing settings page', 'wireframe', 'a billing settings page'],
    ['States:   the plan-picker card', 'states', 'the plan-picker card'],
    ['WIREFRAME:checkout', 'wireframe', 'checkout'],
    ['  states :  the plan-picker card  ', 'states', 'the plan-picker card'],
    ['wireframe: line one\nline two', 'wireframe', 'line one\nline two'],
    ['Variations: a pricing page', 'variations', 'a pricing page'],
    ['storyboard: onboarding flow', 'storyboard', 'onboarding flow'],
    ['Storyboard:  a 30s launch video', 'storyboard', 'a 30s launch video'],
    ['pick: B, but use A\'s navigation', 'pick', 'B, but use A\'s navigation'],
    ['PICK:c', 'pick', 'c'],
    ['spec: the pricing page', 'spec', 'the pricing page'],
    ['SPEC:', 'spec', ''],
    ['report: tranche vesting analysis', 'report', 'tranche vesting analysis'],
    ['Report:  Q3 summary with charts', 'report', 'Q3 summary with charts'],
  ] as const)('parses a leading mode keyword with a colon: %j', (args, mode, brief) => {
    expect(parseDesignModeArgs(args)).toEqual({ mode, brief });
  });

  it.each(['wireframe:', 'States:   ', ' wireframe : '])('returns an empty brief for a bare mode %j', args => {
    expect(parseDesignModeArgs(args)).toEqual({ mode: expect.any(String), brief: '' });
  });

  it.each([
    'states of the union dashboard',
    'wireframe a billing page',
    'foo: a billing page',
    'wireframes: a billing page',
    'variations of a billing page',
    'pick the best layout',
    'specification of a billing page',
    'report on the billing page',
    'reports: monthly',
    'a spec: for review',
    'a page with states: loading and error',
    '',
  ])('treats %j as a plain brief', args => {
    expect(parseDesignModeArgs(args)).toEqual({ brief: args });
  });

  it.each([
    ['B', 'B'], ['b', 'B'], ['  d  ', 'D'], ['B, but use A\'s navigation', 'B'], ['a: tighter spacing', 'A'],
    ['C. make it darker', 'C'], ['C - denser table', 'C'], ['C — denser table', 'C'], ['a\twith notes', 'A'],
  ])('reads pick letter from %j', (brief, letter) => {
    expect(pickLetter(brief)).toBe(letter);
  });

  it.each(['', 'Bold', 'E', 'AB', 'option B', '1', 'B2', '(B)'])('rejects pick brief %j', brief => {
    expect(pickLetter(brief)).toBeUndefined();
  });
});
