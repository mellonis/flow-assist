// The `ui` part of what a plugin is given (src/runtime/plugin-api.ts, `PluginUi`): what
// React and flowtty ship, passed through unchanged. The App calls this once, so every
// plugin of an App holds the same object.

import { Box, Text, Markdown, Table, Link, ScrollBox, Select, ListSelect, ListMultiSelect, Checkbox, TextInput, useInput } from '@flowtty/react';
import { isPrintable, stringWidth } from '@flowtty/core';
import { Fragment, createElement as h, useEffect, useRef, useState } from 'react';
import type { PluginUi } from './plugin-api.js';

export function makePluginUi(): PluginUi {
  return {
    h: h as unknown as PluginUi['h'],
    useState: useState as unknown as PluginUi['useState'],
    useEffect,
    useRef,
    Box,
    Text,
    Markdown,
    Table,
    Link,
    ScrollBox,
    Select,
    ListSelect,
    ListMultiSelect,
    Checkbox,
    TextInput,
    Fragment,
    isPrintable: isPrintable as unknown as PluginUi['isPrintable'],
    stringWidth,
    useInput: useInput as unknown as PluginUi['useInput'],
  };
}
