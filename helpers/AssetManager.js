'use strict';

const fs = require('fs');
const util = require('util');
const multer = require('multer');
const db = require(APP_PATH + '/helpers/database.js');
const md5File = require('md5-file/promise');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const searchableAssets = require(APP_PATH + '/helpers/SearchableAssets.js');

module.exports.UPLOAD_DEST = `${APP_PATH}/uploads/`;

// Upload function generated by Multer.
const upload = multer({
	dest: module.exports.UPLOAD_DEST,
	limits: { fileSize: (config.maxAssetSize || 20) * 1024 * 1024 }, // 20 MB default.
	fileFilter: fileFilter
}).any();

/**
 * Handles file uploading.
 * @param  {obj} req Express request object.
 * @param  {obj} res Express response object.
 * @public
 */
module.exports.assetUploadHandler = async function(req, res) {
	upload(req, res, async function(err) {
		if (err) {
			console.error(err);
			return res.status(409).json(err.code === 'LIMIT_FILE_SIZE'  ?
				{ error: `Maximum file size exceeded (${(config.maxAssetSize || 20)} MB).` } : err);
		}

		if (!req.files) {
			return res.status(422).json({ error: 'Parameter missing from request.' });
		}

		const source = `${req.user.userId} (${req.remoteAddress})`;

		// Adding hashes to each file by initially generating an array of promises that'll trigger with
		// the hash value when each hash has been generated.
		const hashPromises = req.files.map(async file => md5File(file.path));
		const hashes = await Promise.all(hashPromises);
		// After all promises have been resolved, add the hashes to the files.
		req.files.forEach((file, i) => file.fileHash = hashes[i]);

		const duplicatePromises = req.files.map(async (file) => {
			const duplicate = await findDuplicateAsset(file);
			if (!duplicate) return;
			// deleteAssetFromFileSystem actually returns a promise that we could wait for, but there's
			// no reason to make the user wait for us to delete the file. The user doesn't care.
			deleteAssetFromFileSystem(file.filename);
			// Multer uses lower case properties, we save assets as camelCase in the database, so the
			// properties are indeed file.filename and duplicat.fileName (capital N). This is not a typo.
			file.filename = duplicate.fileName;
		});
		await Promise.all(duplicatePromises);

		let searchables = [];
		if (req.body.searchable) {
			// Options don't have types, so if 'searchable' is the literal string true, we make every CSV
			// file uploaded searchable.
			if (req.body.searchable === 'true') {
				searchables = req.files
					.filter(file => file.originalname.endsWith('.csv'))
					.map(file => file.originalname);
			} else {
				// Or if the posted searchable actually is an array of file names to be made searchable,
				// then we just use that.
				if (Array.isArray(req.body.searchable)) {
					searchables = req.body.searchable;
				}
			}
		}

		module.exports.addAssets(req.webstrateId, req.files, searchables, source,
			(err, assetRecords) => {
				if (err) {
					console.error(err);
					return res.status(409).json({ error: String(err) });
				}

				res.json(assetRecords.length === 1 ? assetRecords[0] : assetRecords);
			});
	});
};

/**
 * Find duplicate asset in database (i.e. asset with matching size and hash).
 * @param  {object} asset Asset object.
 * @return {object}       (async) First duplicate asset object if any, otherwise null.
 * @private
 */
const findDuplicateAsset = (asset) =>
	db.assets.findOne({ fileSize: asset.size, fileHash: asset.fileHash });

/**
 * Get list of assets.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Function} next        Callback.
 * @return {array}                (async) List of assets.
 * @public
 */
module.exports.getAssets = function(webstrateId, next) {
	return db.assets.find({ webstrateId }, { _id: 0, _originalId: 0, webstrateId: 0 })
		.toArray(function(err, assets) {
			if (err) return next && next(err);
			assets.forEach(function(asset) {
				asset.identifier = asset.fileName;
				asset.fileName = asset.originalFileName;
				delete asset.originalFileName;
			});
			return next && next(null, assets);
		});
};

/**
 * Get assets accessible at the current version.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Function} next        Callback.
 * @return {array}                (async) List of current assets.
 * @public
 */
module.exports.getCurrentAssets = function(webstrateId, next) {
	return db.assets.find({ webstrateId }, { _id: 0, _originalId: 0, webstrateId: 0 })
		.toArray(function(err, assets) {
			if (err) return next && next(err);
			assets = filterNewestAssets(assets);
			// Filter out deleted assets.
			assets = assets.filter(asset => !asset.deletedAt);
			return next(null, assets);
		});
};

/**
 * Get information on specific asset.
 * @param  {string}   options.webstrateId WebstrateId.
 * @param  {string}   options.assetName   Asset name.
 * @param  {int}      options.version     Version.
 * @param  {Function} next                Callback.
 * @return {obj}                          (async) Asset object.
 * @public
 */
module.exports.getAsset = async function({ webstrateId, assetName, version }) {
	var query = { webstrateId, originalFileName: assetName };
	if (version) query.v = { $lte: +version };
	const asset = await db.assets.findOne(query, { sort: { v: -1 } });
	// If the asset has been deleted, we can't serve it if it was deleted at a prior version than the
	// request, as the asset thus still would be deleted. If we're requesting the current version,
	// the fact that it has been deleted also means we can't serve it. Keep in mind that it's still
	// possible to access a deleted asset at a version prior to its deletion.
	if (asset.deletedAt && ((version && asset.deletedAt <= version) || !version)) return undefined;
	return asset;
};

/**
 * Mark an asset as deleted at a version. This doesn't actually delete the asset from the database
 * or disk, but just marks the asset in the database as deleted. This means that when trying to
 * access the asset at the specific version (or later), it'll appear as if it doesn't exist. When
 * downloading a webstrate at the version (or later), the asset will also not appear in the archive.
 * @param  {string}   webstrateId      WebstrateId.
 * @param  {string}   assetName        Asset name.
 * @param  {Function} next             Callback.
 * @public
 */
module.exports.markAssetAsDeleted = (webstrateId, assetName) => new Promise((accept, reject) => {
	documentManager.getDocumentVersion(webstrateId, (err, version) => {
		db.assets.findOneAndUpdate({ webstrateId, originalFileName: assetName, },
			{ $set: { deletedAt: version } },
			// Sort to ensure that we mark the newest verison of the file as deleted.
			{ sort: { v: -1 } }, (err, res) => {
				if (err || res.value === null) return reject(new Error('Update failed'));
				return accept(res.value);
		});
	});
});

/**
 * Delete asset from database. This is useful if, for some reason, an asset no longer exists in
 * the file system, but still lingers in the database. Also ensures that the file doesn't exist in
 * the database to avoid lingering files in the file system as well.
 * @param  {string} fileName Name of the file in the file system. This is not the original file
 *                           name used when uploading the file, but rather the 'identifier'.
 * @public
 */
module.exports.deleteAssetFromDatabase = (fileName) => {
	if (!fileName || fs.existsSync(`${module.exports.UPLOAD_DEST}${fileName}`)) return;
	return db.assets.deleteOne({ fileName: fileName });
};

/**
 * Delete asset from file system. This is useful if a duplicate file has been uploaded.
 * @param  {string} fileName Name of the file to be deleted
 * @return {Promise}         Promise resolved when the file has been deleted.
 * @private
 */
const deleteAssetFromFileSystem = (fileName) => {
	if (!fileName || !fs.existsSync(`${module.exports.UPLOAD_DEST}${fileName}`)) return;
	const unlink = util.promisify(fs.unlink);
	return unlink(`${module.exports.UPLOAD_DEST}${fileName}`);
};

/**
 * Copy assets from before a certain version of one webstrate to another.
 * When copying a webstrate we want to copy all the assets over as well. The assets are only
 * duplicated in the database, not in the file system.
 * @param  {[type]}   options.fromWebstrateId WebstrateId of source Webstrate copy assets from.
 * @param  {[type]}   options.toWebstrate     WebstrateId of target Webstrate to copy to.
 * @param  {[type]}   options.version         Copy all assets up to this version. When prototyping
 *                                            off version n, we don't want assets from versions
 *                                            newer than n.
 * @param  {Function} next                    Callback.
 * @public
 */
module.exports.copyAssets = function({ fromWebstrateId, toWebstrateId, version }, next) {
	var query = { webstrateId: fromWebstrateId, v: { $lte: version } };
	db.assets.find(query).toArray(function(err, assets) {
		if (err) return next && next(err);
		assets = filterNewestAssets(assets);

		// If there are no assets, we can terminate.
		if (assets.length === 0) return next();

		// When prototyping a new document, we always start from version 0, so we are going to reset
		// all asset versions to version 0 as well. Also, we need to replace the prototype webstrateId
		// (fromWebstrateId) with target webstrateId (toWebstrateId).
		assets.forEach(function(asset) {
			asset.v = 0;
			asset.webstrateId = toWebstrateId;
			// Keep a reference to the old asset. If _originalId already exists, it means the asset we're
			// copying itself is a copy, so we keep a reference to the *real* original. This is needed for
			// asset CSV searching, as we identify CSV rows by their assetId, and when copying a
			// webstrate, we don't copy all the CSV rows.
			asset._originalId = asset._originalId || asset._id;
			delete asset._id;
		});
		db.assets.insertMany(assets, next);
	});
};

/**
 * Restore assets from an older version of a webstrate to a new version.
 * When requesting an asset without a specific version or tag defined, the newest version is
 * always being served. To prevent newer versions from be served with restored webstrates, we
 * therefore copy the assets and bump their versions, so the the old assets now will be newer
 * than the new assets. Yes, that's a good sentence.
 * @param  {string}   options.webstrateId WebstrateId.
 * @param  {int}      options.version     Version to restore from.
 * @param  {string}   options.tag         Tag to deduce version from if no version is provided.
 * @param  {int}      options.newVersion  Version to bump assets to.
 * @param  {Function} next                Callback.
 * @public
 */
module.exports.restoreAssets = function({ webstrateId, version, tag, newVersion }, next) {
	// We need the version, so if it's not defined, we fetch it, and then call ourselves again,
	// this time with the version paramter set.
	if (!version) {
		return documentManager.getVersionFromTag(webstrateId, tag, function(err, version) {
			if (err) return next && next(err);
			module.exports.restoreAssets({ webstrateId, version, tag, newVersion }, next);
		});
	}

	var query = { webstrateId, v: { $lte: version } };
	db.assets.find(query, { _id: 0 }).toArray(function(err, assets) {

		// If there are no assets, we can terminate.
		if (assets.length === 0) return next();

		if (err) return next && next(err);
		assets = filterNewestAssets(assets);
		// Bump the version of all copied assets.
		assets.forEach(asset => asset.v = newVersion);
		db.assets.insertMany(assets, next);
	});
};

/**
 * Delete all assets from a webstrate. If the webstrate has been prototyped/copied, the assets may
 * not be deleted from the file system.
 * @param  {string}   webstrateId WebstrateId to delete assets from.
 * @param  {Function} next        [description]
 * @return {[type]}               [description]
 */
module.exports.deleteAssets = function(webstrateId, next) {
	db.assets.find({ webstrateId }, { fileName: 1 }).toArray(function(err, assets) {
		if (err) return next && next(err);
		// Transform array of objects into primitive array.
		assets.forEach(function(asset, index) {
			assets[index] = asset.fileName;
		});

		// Find all files that are being used by other documents.
		db.assets.distinct('fileName', {
			fileName: { $in: assets },
			webstrateId: { $ne: webstrateId }
		}, function(err, assetsBeingUsed) {
			// Don't delete assets being used by other webstrates.
			var assetsToBeDeleted = assets.filter(asset =>  !assetsBeingUsed.includes(asset));

			var promises = [];
			// Run through the files and delete them.
			assetsToBeDeleted.forEach(function(asset) {
				promises.push(searchableAssets.deleteSearchable(asset._id));
				promises.push(new Promise(function(resolve, reject) {
					fs.unlink(`${module.exports.UPLOAD_DEST}${asset}`, function(err) {
						// We print out errors, but we don't stop execution. If a file fails to delete, we
						// probably still want to get rid of the remaining files.
						if (err) {
							console.error(err);
						}
						resolve();
					});
				}));
			});

			// Once every file has been deleted from the file system, we delete them from the database.
			Promise.all(promises).then(function() {
				db.assets.deleteMany({ webstrateId }, next);
			});
		});
	});
};

/**
 * Filter assets to only keep the newest version of each.
 * When copying or restoring an asset, we only want the assets with the newest version, e.g. if
 * cow.jpg exists both at version 2 and 3, we only want to save the one from version 3, as that's
 * the one that'd be active in the version we're prototyping from.
 * @param  {array} assets List of assets.
 * @return {array}        Filtered list of assets.
 */
function filterNewestAssets(assets) {
	var filteredAssets = {};
	assets.forEach(function(asset) {
		if (!filteredAssets[asset.originalFileName] ||
			filteredAssets[asset.originalFileName].v < asset.v) {
			filteredAssets[asset.originalFileName] = asset;
		}
	});
	return Object.keys(filteredAssets).map(function(key) {
		return filteredAssets[key];
	});
}

/**
 * Add asset uploaded to the database.
 * This is called when a file is uploaded by the AssetManager, and is therefore private. If an
 * asset name already exists with the specific name at the current version, a random string is
 * added to the file name.
 * @param {string}   webstrateId WebstrateId.
 * @param {obj}      asset       Asset information.
 * @param {string}   source      Origin of assets (some client identifier)
 * @param {Function} next        Callback.
 * @public
 */
module.exports.addAsset = function(webstrateId, asset, searchable, source, next) {
	return documentManager.sendNoOp(webstrateId, 'assetAdded', source, function() {
		return documentManager.getDocumentVersion(webstrateId, function(err, version) {
			db.assets.insert({
				webstrateId,
				v: version,
				// asset.filename is the name of the file on our system, originalname is what the file was
				// called on the uploading client's system.
				fileName: asset.filename,
				originalFileName: asset.originalname,
				fileSize: asset.size,
				mimeType: asset.mimetype,
				fileHash: asset.fileHash
			}, async function(err, result) {
				if (err) return next && next(err);

				if (searchable && asset.mimetype === 'text/csv') {
					const assetId = result.ops[0]._id;
					await searchableAssets.makeSearchable(assetId,
						module.exports.UPLOAD_DEST + asset.filename);
				}

				asset = {
					v: version,
					fileName: asset.originalname,
					fileSize: asset.size,
					mimeType: asset.mimetype,
					identifier: asset.filename,
					fileHash: asset.fileHash
				};

				// Inform all clients of the newly added asset.
				clientManager.announceNewAsset(webstrateId, asset, true);

				return next && next(null, asset);
			});
		});
	});
};

/**
 * Add assets uploaded to the database. Just calls module.exports.addAsset a bunch of times.
 * @param {string}   webstrateId WebstrateId.
 * @param {array}    assets      List of asset objects to add to the database.
 * @param {array}    searchables List of assets file names to make searchable. All file names here
 *                               should be a subset of the file names in the assets list.
 * @param {string}   source      Origin of assets (some client identifier)
 * @param {Function} next        Callback.
 * @public
 */
module.exports.addAssets = function(webstrateId, assets, searchables, source, next) {
	var assetPromises = [];
	assets.forEach(function(asset) {
		assetPromises.push(new Promise(function(accept, reject) {
			const searchable = searchables.includes(asset.originalname);
			module.exports.addAsset(webstrateId, asset, searchable, source, function(err, assetRecord) {
				if (err) return reject(err);
				accept(assetRecord);
			});
		}));
	});

	Promise.all(assetPromises).then(function(assetRecords) {
		next(null, assetRecords.length === 1 ? assetRecords[0] : assetRecords);
	}).catch(function(err) {
		next(err);
	});
};

/**
 * Filter Multer file uploads to ensure that the webstrate exists and that the user has the
 * appropriate permissions.
 * @param  {obj}      req  Express Request object.
 * @param  {obj}      file Multer file object.
 * @param  {Function} next Callback.
 * @return {bool}          (async) Whether the file is permitted to be uploaded or not.
 * @private
 */
function fileFilter(req, file, next) {
	return documentManager.getDocument({ webstrateId: req.webstrateId }, function(err, snapshot) {
		if (err) {
			return next(err);
		}

		if (!snapshot.type) {
			return next(new Error('Document doesn\'t exist.'));
		}

		var permissions = permissionManager.getUserPermissionsFromSnapshot(req.user.username,
			req.user.provider, snapshot);

		if (!permissions.includes('w')) {
			return next(new Error('Insufficient permissions.'));
		}

		return next(null, true);
	});
}