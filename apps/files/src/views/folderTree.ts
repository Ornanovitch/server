/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { TreeNode } from '../services/FolderTree.ts'

import PQueue from 'p-queue'
import { Folder, Node, View, getNavigation } from '@nextcloud/files'
import { translate as t } from '@nextcloud/l10n'
import { emit, subscribe } from '@nextcloud/event-bus'
import { isSamePath } from '@nextcloud/paths'
import { loadState } from '@nextcloud/initial-state'

import FolderSvg from '@mdi/svg/svg/folder.svg?raw'
import FolderMultipleSvg from '@mdi/svg/svg/folder-multiple.svg?raw'

import {
	encodeSource,
	folderTreeId,
	getContents,
	getFolderTreeNodes,
	getFolderTreeParentId,
	getFolderTreeViewId,
	getSourceParent,
	sourceRoot,
} from '../services/FolderTree.ts'

const isFolderTreeEnabled = loadState('files', 'config', { folder_tree: true }).folder_tree

const Navigation = getNavigation()

const queue = new PQueue({ concurrency: 5, intervalCap: 5, interval: 200 })

const registerQueue = new PQueue({ concurrency: 5, intervalCap: 5, interval: 200 })

const registerTreeNodes = async (path: string = '/') => {
	await queue.add(async () => {
		const nodes = await getFolderTreeNodes(path)
		const promises = nodes.map(node => registerQueue.add(() => registerTreeNodeView(node)))
		await Promise.allSettled(promises)
	})
}

const getLoadChildViews = (node: TreeNode | Folder) => {
	return async (view: View): Promise<void> => {
		// @ts-expect-error Custom property on View instance
		if (view.loading || view.loaded) {
			return
		}
		// @ts-expect-error Custom property
		view.loading = true
		await registerTreeNodes(node.path)
		// @ts-expect-error Custom property
		view.loading = false
		// @ts-expect-error Custom property
		view.loaded = true
		// @ts-expect-error No payload
		emit('files:navigation:updated')
		// @ts-expect-error No payload
		emit('files:folder-tree:expanded')
	}
}

const registerTreeNodeView = (node: TreeNode) => {
	Navigation.register(new View({
		id: encodeSource(node.source),
		parent: getSourceParent(node.source),

		name: node.displayName ?? node.basename,

		icon: FolderSvg,

		getContents,
		loadChildViews: getLoadChildViews(node),

		params: {
			view: folderTreeId,
			fileid: String(node.fileid), // Needed for matching exact routes
			dir: node.path,
		},
	}))
}

const registerFolderView = (folder: Folder) => {
	Navigation.register(new View({
		id: getFolderTreeViewId(folder),
		parent: getFolderTreeParentId(folder),

		name: folder.displayname,

		icon: FolderSvg,

		getContents,
		loadChildViews: getLoadChildViews(folder),

		params: {
			view: folderTreeId,
			fileid: String(folder.fileid),
			dir: folder.path,
		},
	}))
}

const removeFolderView = (folder: Folder) => {
	const viewId = getFolderTreeViewId(folder)
	Navigation.remove(viewId)
}

const removeFolderViewSource = (source: string) => {
	Navigation.remove(source)
}

const onCreateNode = (node: Node) => {
	if (!(node instanceof Folder)) {
		return
	}
	registerFolderView(node)
}

const onDeleteNode = (node: Node) => {
	if (!(node instanceof Folder)) {
		return
	}
	removeFolderView(node)
}

const onMoveNode = ({ node, oldSource }) => {
	if (!(node instanceof Folder)) {
		return
	}
	removeFolderViewSource(oldSource)
	registerFolderView(node)

	const newPath = node.source.replace(sourceRoot, '')
	const oldPath = oldSource.replace(sourceRoot, '')
	const childViews = Navigation.views.filter(view => {
		if (!view.params?.dir) {
			return false
		}
		if (isSamePath(view.params.dir, oldPath)) {
			return false
		}
		return view.params.dir.startsWith(oldPath)
	})
	for (const view of childViews) {
		// @ts-expect-error FIXME Allow setting parent
		view.parent = getFolderTreeParentId(node)
		// @ts-expect-error dir param is defined
		view.params.dir = view.params.dir.replace(oldPath, newPath)
	}
}

const registerFolderTreeRoot = () => {
	Navigation.register(new View({
		id: folderTreeId,

		name: t('files', 'All folders'),
		caption: t('files', 'List of your files and folders.'),

		icon: FolderMultipleSvg,
		order: 50, // Below all other views

		getContents,
	}))
}

const registerFolderTreeChildren = async () => {
	await registerTreeNodes()
	subscribe('files:node:created', onCreateNode)
	subscribe('files:node:deleted', onDeleteNode)
	subscribe('files:node:moved', onMoveNode)
	// @ts-expect-error No payload
	emit('files:folder-tree:initialized')
}

export const registerFolderTreeView = async () => {
	if (!isFolderTreeEnabled) {
		return
	}
	registerFolderTreeRoot()
	await registerFolderTreeChildren()
}
