/**
 * Unit tests for resolveDockerSocketPath (#3648) — the active-docker-context
 * socket-path resolver used at both compose bind sites (hostd proxy :ro,
 * root-agent :rw).
 */
import { describe, expect, it } from "vitest";
import {
  resolveDockerSocketPath,
  DEFAULT_DOCKER_SOCKET_PATH,
} from "./docker-socket.js";

describe("resolveDockerSocketPath (#3648)", () => {
  it("strips the unix:// scheme from a unix endpoint", () => {
    expect(
      resolveDockerSocketPath(() => "unix:///run/user/1000/docker.sock"),
    ).toBe("/run/user/1000/docker.sock");
  });

  it("returns the same default path when the context IS the default socket", () => {
    expect(
      resolveDockerSocketPath(() => "unix:///var/run/docker.sock"),
    ).toBe("/var/run/docker.sock");
  });

  it("tolerates trailing whitespace in the endpoint", () => {
    expect(
      resolveDockerSocketPath(() => "unix:///rootless/docker.sock\n"),
    ).toBe("/rootless/docker.sock");
  });

  it("falls back to the default for a non-unix (tcp://) endpoint", () => {
    expect(resolveDockerSocketPath(() => "tcp://1.2.3.4:2375")).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
  });

  it("falls back to the default for an ssh:// endpoint", () => {
    expect(resolveDockerSocketPath(() => "ssh://user@host")).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
  });

  it("falls back to the default when the probe yields nothing (docker missing / probe failed)", () => {
    expect(resolveDockerSocketPath(() => null)).toBe(DEFAULT_DOCKER_SOCKET_PATH);
  });

  it("falls back to the default for a bare unix:// with no path", () => {
    expect(resolveDockerSocketPath(() => "unix://")).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
  });
});
