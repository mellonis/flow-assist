# @flow-assist/remote

Write a [flow-assist](https://github.com/mellonis/flow-assist) plugin as a separate process. The host talks to it over JSON-RPC 2.0, one message per line; the plugin keeps its own state and sends a *frame* — its whole screen as a JSON tree — whenever it changes; the host draws it. This package is the protocol's types, its line codec, and `runPlugin`, a runtime that speaks it for you.

The protocol's number is the host API's (`PROTOCOL_HOST_API`); the package ships with each host release under the same version.
