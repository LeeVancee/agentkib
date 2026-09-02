/* eslint-disable */

// @ts-nocheck

// noinspection JSUnusedGlobalSymbols

// This route tree is committed because the current TanStack generator does not
// support Octane targets. Keep it synchronized with the files in ./routes.

import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as AgentsRouteImport } from './routes/agents'
import { Route as CatalogRouteImport } from './routes/catalog'
import { Route as InsightsRouteImport } from './routes/insights'
import { Route as QuotaRouteImport } from './routes/quota'
import { Route as SettingsRouteImport } from './routes/settings'
import { Route as WorkspacesRouteImport } from './routes/workspaces'
import { Route as WorkspaceWorkspaceIdRouteRouteImport } from './routes/workspace/$workspaceId/route'
import { Route as WorkspaceWorkspaceIdIndexRouteImport } from './routes/workspace/$workspaceId/index'
import { Route as WorkspaceWorkspaceIdAssetsRouteImport } from './routes/workspace/$workspaceId/assets'
import { Route as WorkspaceWorkspaceIdChangesRouteImport } from './routes/workspace/$workspaceId/changes'
import { Route as WorkspaceWorkspaceIdContextRouteImport } from './routes/workspace/$workspaceId/context'
import { Route as WorkspaceWorkspaceIdDoctorRouteImport } from './routes/workspace/$workspaceId/doctor'
import { Route as WorkspaceWorkspaceIdGitRouteImport } from './routes/workspace/$workspaceId/git'
import { Route as WorkspaceWorkspaceIdSessionsRouteImport } from './routes/workspace/$workspaceId/sessions'

const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)
const AgentsRoute = AgentsRouteImport.update({
  id: '/agents',
  path: '/agents',
  getParentRoute: () => rootRouteImport,
} as any)
const CatalogRoute = CatalogRouteImport.update({
  id: '/catalog',
  path: '/catalog',
  getParentRoute: () => rootRouteImport,
} as any)
const InsightsRoute = InsightsRouteImport.update({
  id: '/insights',
  path: '/insights',
  getParentRoute: () => rootRouteImport,
} as any)
const QuotaRoute = QuotaRouteImport.update({
  id: '/quota',
  path: '/quota',
  getParentRoute: () => rootRouteImport,
} as any)
const SettingsRoute = SettingsRouteImport.update({
  id: '/settings',
  path: '/settings',
  getParentRoute: () => rootRouteImport,
} as any)
const WorkspacesRoute = WorkspacesRouteImport.update({
  id: '/workspaces',
  path: '/workspaces',
  getParentRoute: () => rootRouteImport,
} as any)
const WorkspaceWorkspaceIdRouteRoute =
  WorkspaceWorkspaceIdRouteRouteImport.update({
    id: '/workspace/$workspaceId',
    path: '/workspace/$workspaceId',
    getParentRoute: () => rootRouteImport,
  } as any)
const WorkspaceWorkspaceIdIndexRoute =
  WorkspaceWorkspaceIdIndexRouteImport.update({
    id: '/',
    path: '/',
    getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
  } as any)
const WorkspaceWorkspaceIdAssetsRoute =
  WorkspaceWorkspaceIdAssetsRouteImport.update({
    id: '/assets',
    path: '/assets',
    getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
  } as any)
const WorkspaceWorkspaceIdChangesRoute =
  WorkspaceWorkspaceIdChangesRouteImport.update({
    id: '/changes',
    path: '/changes',
    getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
  } as any)
const WorkspaceWorkspaceIdContextRoute =
  WorkspaceWorkspaceIdContextRouteImport.update({
    id: '/context',
    path: '/context',
    getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
  } as any)
const WorkspaceWorkspaceIdDoctorRoute =
  WorkspaceWorkspaceIdDoctorRouteImport.update({
    id: '/doctor',
    path: '/doctor',
    getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
  } as any)
const WorkspaceWorkspaceIdGitRoute = WorkspaceWorkspaceIdGitRouteImport.update({
  id: '/git',
  path: '/git',
  getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
} as any)
const WorkspaceWorkspaceIdSessionsRoute =
  WorkspaceWorkspaceIdSessionsRouteImport.update({
    id: '/sessions',
    path: '/sessions',
    getParentRoute: () => WorkspaceWorkspaceIdRouteRoute,
  } as any)

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/agents': typeof AgentsRoute
  '/catalog': typeof CatalogRoute
  '/insights': typeof InsightsRoute
  '/quota': typeof QuotaRoute
  '/settings': typeof SettingsRoute
  '/workspaces': typeof WorkspacesRoute
  '/workspace/$workspaceId': typeof WorkspaceWorkspaceIdRouteRouteWithChildren
  '/workspace/$workspaceId/assets': typeof WorkspaceWorkspaceIdAssetsRoute
  '/workspace/$workspaceId/changes': typeof WorkspaceWorkspaceIdChangesRoute
  '/workspace/$workspaceId/context': typeof WorkspaceWorkspaceIdContextRoute
  '/workspace/$workspaceId/doctor': typeof WorkspaceWorkspaceIdDoctorRoute
  '/workspace/$workspaceId/git': typeof WorkspaceWorkspaceIdGitRoute
  '/workspace/$workspaceId/sessions': typeof WorkspaceWorkspaceIdSessionsRoute
  '/workspace/$workspaceId/': typeof WorkspaceWorkspaceIdIndexRoute
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
  '/agents': typeof AgentsRoute
  '/catalog': typeof CatalogRoute
  '/insights': typeof InsightsRoute
  '/quota': typeof QuotaRoute
  '/settings': typeof SettingsRoute
  '/workspaces': typeof WorkspacesRoute
  '/workspace/$workspaceId/assets': typeof WorkspaceWorkspaceIdAssetsRoute
  '/workspace/$workspaceId/changes': typeof WorkspaceWorkspaceIdChangesRoute
  '/workspace/$workspaceId/context': typeof WorkspaceWorkspaceIdContextRoute
  '/workspace/$workspaceId/doctor': typeof WorkspaceWorkspaceIdDoctorRoute
  '/workspace/$workspaceId/git': typeof WorkspaceWorkspaceIdGitRoute
  '/workspace/$workspaceId/sessions': typeof WorkspaceWorkspaceIdSessionsRoute
  '/workspace/$workspaceId': typeof WorkspaceWorkspaceIdIndexRoute
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/': typeof IndexRoute
  '/agents': typeof AgentsRoute
  '/catalog': typeof CatalogRoute
  '/insights': typeof InsightsRoute
  '/quota': typeof QuotaRoute
  '/settings': typeof SettingsRoute
  '/workspaces': typeof WorkspacesRoute
  '/workspace/$workspaceId': typeof WorkspaceWorkspaceIdRouteRouteWithChildren
  '/workspace/$workspaceId/assets': typeof WorkspaceWorkspaceIdAssetsRoute
  '/workspace/$workspaceId/changes': typeof WorkspaceWorkspaceIdChangesRoute
  '/workspace/$workspaceId/context': typeof WorkspaceWorkspaceIdContextRoute
  '/workspace/$workspaceId/doctor': typeof WorkspaceWorkspaceIdDoctorRoute
  '/workspace/$workspaceId/git': typeof WorkspaceWorkspaceIdGitRoute
  '/workspace/$workspaceId/sessions': typeof WorkspaceWorkspaceIdSessionsRoute
  '/workspace/$workspaceId/': typeof WorkspaceWorkspaceIdIndexRoute
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths:
    | '/'
    | '/agents'
    | '/catalog'
    | '/insights'
    | '/quota'
    | '/settings'
    | '/workspaces'
    | '/workspace/$workspaceId'
    | '/workspace/$workspaceId/assets'
    | '/workspace/$workspaceId/changes'
    | '/workspace/$workspaceId/context'
    | '/workspace/$workspaceId/doctor'
    | '/workspace/$workspaceId/git'
    | '/workspace/$workspaceId/sessions'
    | '/workspace/$workspaceId/'
  fileRoutesByTo: FileRoutesByTo
  to:
    | '/'
    | '/agents'
    | '/catalog'
    | '/insights'
    | '/quota'
    | '/settings'
    | '/workspaces'
    | '/workspace/$workspaceId/assets'
    | '/workspace/$workspaceId/changes'
    | '/workspace/$workspaceId/context'
    | '/workspace/$workspaceId/doctor'
    | '/workspace/$workspaceId/git'
    | '/workspace/$workspaceId/sessions'
    | '/workspace/$workspaceId'
  id:
    | '__root__'
    | '/'
    | '/agents'
    | '/catalog'
    | '/insights'
    | '/quota'
    | '/settings'
    | '/workspaces'
    | '/workspace/$workspaceId'
    | '/workspace/$workspaceId/assets'
    | '/workspace/$workspaceId/changes'
    | '/workspace/$workspaceId/context'
    | '/workspace/$workspaceId/doctor'
    | '/workspace/$workspaceId/git'
    | '/workspace/$workspaceId/sessions'
    | '/workspace/$workspaceId/'
  fileRoutesById: FileRoutesById
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute
  AgentsRoute: typeof AgentsRoute
  CatalogRoute: typeof CatalogRoute
  InsightsRoute: typeof InsightsRoute
  QuotaRoute: typeof QuotaRoute
  SettingsRoute: typeof SettingsRoute
  WorkspacesRoute: typeof WorkspacesRoute
  WorkspaceWorkspaceIdRouteRoute: typeof WorkspaceWorkspaceIdRouteRouteWithChildren
}

declare module '@octanejs/tanstack-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/agents': {
      id: '/agents'
      path: '/agents'
      fullPath: '/agents'
      preLoaderRoute: typeof AgentsRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/catalog': {
      id: '/catalog'
      path: '/catalog'
      fullPath: '/catalog'
      preLoaderRoute: typeof CatalogRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/insights': {
      id: '/insights'
      path: '/insights'
      fullPath: '/insights'
      preLoaderRoute: typeof InsightsRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/quota': {
      id: '/quota'
      path: '/quota'
      fullPath: '/quota'
      preLoaderRoute: typeof QuotaRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/settings': {
      id: '/settings'
      path: '/settings'
      fullPath: '/settings'
      preLoaderRoute: typeof SettingsRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/workspaces': {
      id: '/workspaces'
      path: '/workspaces'
      fullPath: '/workspaces'
      preLoaderRoute: typeof WorkspacesRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/workspace/$workspaceId': {
      id: '/workspace/$workspaceId'
      path: '/workspace/$workspaceId'
      fullPath: '/workspace/$workspaceId'
      preLoaderRoute: typeof WorkspaceWorkspaceIdRouteRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/workspace/$workspaceId/': {
      id: '/workspace/$workspaceId/'
      path: '/'
      fullPath: '/workspace/$workspaceId/'
      preLoaderRoute: typeof WorkspaceWorkspaceIdIndexRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
    '/workspace/$workspaceId/assets': {
      id: '/workspace/$workspaceId/assets'
      path: '/assets'
      fullPath: '/workspace/$workspaceId/assets'
      preLoaderRoute: typeof WorkspaceWorkspaceIdAssetsRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
    '/workspace/$workspaceId/changes': {
      id: '/workspace/$workspaceId/changes'
      path: '/changes'
      fullPath: '/workspace/$workspaceId/changes'
      preLoaderRoute: typeof WorkspaceWorkspaceIdChangesRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
    '/workspace/$workspaceId/context': {
      id: '/workspace/$workspaceId/context'
      path: '/context'
      fullPath: '/workspace/$workspaceId/context'
      preLoaderRoute: typeof WorkspaceWorkspaceIdContextRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
    '/workspace/$workspaceId/doctor': {
      id: '/workspace/$workspaceId/doctor'
      path: '/doctor'
      fullPath: '/workspace/$workspaceId/doctor'
      preLoaderRoute: typeof WorkspaceWorkspaceIdDoctorRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
    '/workspace/$workspaceId/git': {
      id: '/workspace/$workspaceId/git'
      path: '/git'
      fullPath: '/workspace/$workspaceId/git'
      preLoaderRoute: typeof WorkspaceWorkspaceIdGitRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
    '/workspace/$workspaceId/sessions': {
      id: '/workspace/$workspaceId/sessions'
      path: '/sessions'
      fullPath: '/workspace/$workspaceId/sessions'
      preLoaderRoute: typeof WorkspaceWorkspaceIdSessionsRouteImport
      parentRoute: typeof WorkspaceWorkspaceIdRouteRoute
    }
  }
}

interface WorkspaceWorkspaceIdRouteRouteChildren {
  WorkspaceWorkspaceIdAssetsRoute: typeof WorkspaceWorkspaceIdAssetsRoute
  WorkspaceWorkspaceIdChangesRoute: typeof WorkspaceWorkspaceIdChangesRoute
  WorkspaceWorkspaceIdContextRoute: typeof WorkspaceWorkspaceIdContextRoute
  WorkspaceWorkspaceIdDoctorRoute: typeof WorkspaceWorkspaceIdDoctorRoute
  WorkspaceWorkspaceIdGitRoute: typeof WorkspaceWorkspaceIdGitRoute
  WorkspaceWorkspaceIdSessionsRoute: typeof WorkspaceWorkspaceIdSessionsRoute
  WorkspaceWorkspaceIdIndexRoute: typeof WorkspaceWorkspaceIdIndexRoute
}

const WorkspaceWorkspaceIdRouteRouteChildren: WorkspaceWorkspaceIdRouteRouteChildren =
  {
    WorkspaceWorkspaceIdAssetsRoute: WorkspaceWorkspaceIdAssetsRoute,
    WorkspaceWorkspaceIdChangesRoute: WorkspaceWorkspaceIdChangesRoute,
    WorkspaceWorkspaceIdContextRoute: WorkspaceWorkspaceIdContextRoute,
    WorkspaceWorkspaceIdDoctorRoute: WorkspaceWorkspaceIdDoctorRoute,
    WorkspaceWorkspaceIdGitRoute: WorkspaceWorkspaceIdGitRoute,
    WorkspaceWorkspaceIdSessionsRoute: WorkspaceWorkspaceIdSessionsRoute,
    WorkspaceWorkspaceIdIndexRoute: WorkspaceWorkspaceIdIndexRoute,
  }

const WorkspaceWorkspaceIdRouteRouteWithChildren =
  WorkspaceWorkspaceIdRouteRoute._addFileChildren(
    WorkspaceWorkspaceIdRouteRouteChildren,
  )

const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
  AgentsRoute: AgentsRoute,
  CatalogRoute: CatalogRoute,
  InsightsRoute: InsightsRoute,
  QuotaRoute: QuotaRoute,
  SettingsRoute: SettingsRoute,
  WorkspacesRoute: WorkspacesRoute,
  WorkspaceWorkspaceIdRouteRoute: WorkspaceWorkspaceIdRouteRouteWithChildren,
}
export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>()
