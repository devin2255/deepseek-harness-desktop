import { describe, expect, it } from 'vitest'
import {
  configureAuthorizedSession,
  DESKTOP_SESSION_PARTITION,
  type AuthorizedSessionDependencies,
  type BeforeSendHeadersCallback,
  type BeforeSendHeadersDetails,
  type BeforeSendHeadersListener,
} from '../src/authorized-session.ts'

type PermissionCheck = (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean
type PermissionRequest = (
  webContents: unknown,
  permission: string,
  callback: (permissionGranted: boolean) => void,
  details: unknown,
) => void

function authorizedSession(): {
  readonly dependencies: AuthorizedSessionDependencies
  readonly fromPartitions: { readonly partition: string; readonly cache: boolean }[]
  readonly filters: string[][]
  readonly listener: () => BeforeSendHeadersListener
  readonly permissionCheck: () => PermissionCheck
  readonly permissionRequest: () => PermissionRequest
  readonly removals: string[]
} {
  const fromPartitions: { partition: string; cache: boolean }[] = []
  const filters: string[][] = []
  const removals: string[] = []
  let headerListener: BeforeSendHeadersListener | undefined
  let checkHandler: PermissionCheck | undefined
  let requestHandler: PermissionRequest | undefined
  const fakeSession = {
    request: {
      onBeforeSendHeaders(
        filter: { readonly urls: string[] } | null,
        listener?: BeforeSendHeadersListener | null,
      ): void {
        if (filter === null) removals.push('headers')
        else {
          filters.push(filter.urls)
          if (listener !== null && listener !== undefined) headerListener = listener
        }
      },
    },
    setPermissionCheckHandler(handler: PermissionCheck | null): void {
      if (handler === null) removals.push('check')
      else checkHandler = handler
    },
    setPermissionRequestHandler(handler: PermissionRequest | null): void {
      if (handler === null) removals.push('request')
      else requestHandler = handler
    },
  }
  return {
    dependencies: {
      fromPartition(partition, options) {
        fromPartitions.push({ partition, cache: options.cache })
        return fakeSession
      },
    },
    fromPartitions,
    filters,
    listener() {
      if (headerListener === undefined) throw new Error('Expected an onBeforeSendHeaders listener')
      return headerListener
    },
    permissionCheck() {
      if (checkHandler === undefined) throw new Error('Expected a permission-check handler')
      return checkHandler
    },
    permissionRequest() {
      if (requestHandler === undefined) throw new Error('Expected a permission-request handler')
      return requestHandler
    },
    removals,
  }
}

function request(
  overrides: Partial<BeforeSendHeadersDetails> = {},
): {
  readonly details: BeforeSendHeadersDetails
  readonly response: () => Parameters<BeforeSendHeadersCallback>[0] | undefined
  readonly callback: BeforeSendHeadersCallback
} {
  let decision: Parameters<BeforeSendHeadersCallback>[0] | undefined
  return {
    details: {
      requestHeaders: { Accept: '*/*', Existing: 'kept' },
      resourceType: 'xhr',
      url: 'http://127.0.0.1:4312/api/sessions',
      webContentsId: 19,
      ...overrides,
    },
    response: () => decision,
    callback(response) {
      decision = response
    },
  }
}

describe('configureAuthorizedSession', () => {
  it('uses the isolated cached desktop partition with exact HTTP and WebSocket filters', () => {
    const fixture = authorizedSession()

    configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)

    expect(fixture.fromPartitions).toEqual([{ partition: DESKTOP_SESSION_PARTITION, cache: true }])
    expect(fixture.filters).toEqual([['http://127.0.0.1:4312/*', 'ws://127.0.0.1:4312/*']])
  })

  it('normalizes the default loopback port while retaining explicit HTTP and WebSocket filters', () => {
    const fixture = authorizedSession()
    const authorization = configureAuthorizedSession(new URL('http://127.0.0.1:80'), 'capability', fixture.dependencies)
    authorization.bind(19)
    const actual = request({ url: 'ws://127.0.0.1:80/socket' })

    fixture.listener()(actual.details, actual.callback)

    expect(fixture.filters).toEqual([['http://127.0.0.1:80/*', 'ws://127.0.0.1:80/*']])
    expect(actual.response()).toEqual({
      requestHeaders: { Accept: '*/*', Existing: 'kept', Authorization: 'Bearer capability' },
    })
  })

  it('rejects an endpoint that is not precisely a loopback HTTP origin with a valid port', () => {
    const fixture = authorizedSession()

    for (const endpoint of [
      'http://localhost:4312',
      'https://127.0.0.1:4312',
      'http://127.0.0.1:0',
      'http://127.0.0.1:4312/path',
      'http://127.0.0.1:4312?query',
      'http://127.0.0.1:4312#fragment',
    ]) {
      expect(() => configureAuthorizedSession(new URL(endpoint), 'capability', fixture.dependencies)).toThrow(/endpoint/u)
    }
    expect(fixture.fromPartitions).toEqual([])
  })

  it('denies every permission check and request', () => {
    const fixture = authorizedSession()
    configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    let granted: boolean | undefined

    expect(fixture.permissionCheck()(null, 'clipboard-read', 'http://127.0.0.1:4312', {})).toBe(false)
    fixture.permissionRequest()({}, 'media', (value) => {
      granted = value
    }, {})
    expect(granted).toBe(false)
  })

  it('fails closed before a window is bound', () => {
    const fixture = authorizedSession()
    configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    const actual = request()

    fixture.listener()(actual.details, actual.callback)

    expect(actual.response()).toEqual({ cancel: true })
  })

  it('preserves headers and replaces all authorization values for bound matching requests', () => {
    const fixture = authorizedSession()
    const authorization = configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    authorization.bind(19)
    const actual = request({ requestHeaders: { authorization: 'stale', Existing: 'kept' } })

    fixture.listener()(actual.details, actual.callback)

    expect(actual.response()).toEqual({
      requestHeaders: { Authorization: 'Bearer capability', Existing: 'kept' },
    })
  })

  it('authorizes every exact-origin resource type only for the bound renderer', () => {
    const fixture = authorizedSession()
    const authorization = configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    authorization.bind(19)

    for (const resourceType of [
      'mainFrame',
      'subFrame',
      'stylesheet',
      'script',
      'image',
      'font',
      'object',
      'xhr',
      'ping',
      'cspReport',
      'media',
      'webSocket',
      'other',
    ]) {
      const actual = request({ resourceType })
      fixture.listener()(actual.details, actual.callback)
      expect(actual.response()).toEqual({
        requestHeaders: { Accept: '*/*', Existing: 'kept', Authorization: 'Bearer capability' },
      })
    }
  })

  it('cancels matching requests from a missing or different webContents', () => {
    const fixture = authorizedSession()
    const authorization = configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    authorization.bind(19)

    for (const webContentsId of [undefined, 20]) {
      const actual = request({ webContentsId })
      fixture.listener()(actual.details, actual.callback)
      expect(actual.response()).toEqual({ cancel: true })
    }
  })

  it('defensively leaves nonmatching URLs unchanged when Electron invokes the listener outside its filter', () => {
    const fixture = authorizedSession()
    const authorization = configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    authorization.bind(19)

    for (const url of [
      'http://localhost:4312/api',
      'http://127.0.0.1:4313/api',
      'https://127.0.0.1:4312/api',
      'wss://127.0.0.1:4312/api',
      'https://example.com/',
    ]) {
      const actual = request({ url })
      fixture.listener()(actual.details, actual.callback)
      expect(actual.response()).toEqual({ requestHeaders: { Accept: '*/*', Existing: 'kept' } })
    }
  })

  it('removes the isolated session handlers when disposed', () => {
    const fixture = authorizedSession()
    const authorization = configureAuthorizedSession(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)

    authorization.dispose()
    authorization.dispose()

    expect(fixture.removals).toEqual(['headers', 'check', 'request'])
  })
})
