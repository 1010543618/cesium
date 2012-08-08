/*global define*/
define([
        './defaultValue',
        './getImagePixels',
        './DeveloperError',
        './Ellipsoid',
        './Extent',
        './Cartesian3',
        './ComponentDatatype',
        './PrimitiveType',
        './Math'
    ], function(
        defaultValue,
        getImagePixels,
        DeveloperError,
        Ellipsoid,
        Extent,
        Cartesian3,
        ComponentDatatype,
        PrimitiveType,
        CesiumMath) {
    "use strict";

    /**
     * Contains class functions to create a mesh or vertex array from a heightmap image.
     *
     * @exports HeightmapTessellator
     *
     * @see CubeMapEllipsoidTessellator
     * @see BoxTessellator
     * @see PlaneTessellator
     */
    var HeightmapTessellator = {};

    /**
     * Compute vertices from a heightmap image.  This function is lower-level than the other
     * functions on this class.
     *
     * @param description.heightmap The heightmap image, as a pixel array.
     * @param {Number} description.heightScale DOC_TBA
     * @param {Number} description.heightOffset DOC_TBA
     * @param {Number} description.bytesPerHeight DOC_TBA
     * @param {Number} description.stride DOC_TBA
     * @param {Number} description.width The width of the heightmap image.
     * @param {Number} description.height The height of the heightmap image.
     * @param {Extent} description.extent A cartographic extent with north, south, east and west properties in radians.
     * @param {Boolean} description.generateTextureCoordinates Whether to generate texture coordinates.
     * @param {Boolean} description.interleaveTextureCoordinates Whether to interleave the texture coordinates into the vertex array.
     * @param {Cartesian3} description.relativetoCenter The positions will be computed as <code>worldPosition.subtract(relativeToCenter)</code>.
     * @param {Cartesian3} description.radiiSquared The radii squared of the ellipsoid to use.
     * @param {Array|Float32Array} description.vertices The array to use to store computed vertices.
     * @param {Array|Float32Array} description.textureCoordinates The array to use to store computed texture coordinates, unless interleaved.
     * @param {Array|Float32Array} [description.indices] The array to use to store computed indices.  If undefined, indices will be not computed.
     */
    HeightmapTessellator.computeVertices = function(description) {
        description = defaultValue(description, {});

        var heightmap = description.heightmap;
        var heightScale = description.heightScale;
        var heightOffset = description.heightOffset;
        var bytesPerHeight = description.bytesPerHeight;
        var stride = description.stride;
        var width = description.width;
        var height = description.height;

        var extent = description.extent;
        var granularityX = (extent.east - extent.west) / (width - 1);
        var granularityY = (extent.north - extent.south) / (height - 1);
        var generateTextureCoordinates = description.generateTextureCoordinates;
        var interleaveTextureCoordinates = description.interleaveTextureCoordinates;
        var relativeToCenter = description.relativeToCenter;
        var isGeographic = description.isGeographic;
        var voidIndicator = defaultValue(description.voidIndicator, -32768);
        var voidFillValue = defaultValue(description.voidFillValue, 0);

        var vertices = description.vertices;
        var textureCoordinates = description.textureCoordinates;
        var indices = description.indices;

        var radiiSquared = description.radiiSquared;
        var radiiSquaredX = radiiSquared.x;
        var radiiSquaredY = radiiSquared.y;
        var radiiSquaredZ = radiiSquared.z;

        var oneOverCentralBodySemimajorAxis = description.oneOverCentralBodySemimajorAxis;

        var cos = Math.cos;
        var sin = Math.sin;
        var sqrt = Math.sqrt;
        var atan = Math.atan;
        var exp = Math.exp;
        var piOverTwo = Math.PI / 2.0;
        var toRadians = CesiumMath.toRadians;

        var geographicWest = extent.west * oneOverCentralBodySemimajorAxis;
        var geographicSouth = piOverTwo - (2.0 * atan(exp(-extent.south * oneOverCentralBodySemimajorAxis)));
        var geographicEast = extent.east * oneOverCentralBodySemimajorAxis;
        var geographicNorth = piOverTwo - (2.0 * atan(exp(-extent.north * oneOverCentralBodySemimajorAxis)));

        var vertexArrayIndex = 0;
        var textureCoordinatesIndex = 0;

        var minHeight = 65536.0;
        var maxHeight = -65536.0;

        for ( var row = 0; row < height; ++row) {
            var latitude = extent.north - granularityY * row;
            if (!isGeographic) {
                latitude = piOverTwo - (2.0 * atan(exp(-latitude * oneOverCentralBodySemimajorAxis)));
            } else {
                latitude = toRadians(latitude);
            }
            var cosLatitude = cos(latitude);
            var nZ = sin(latitude);
            var kZ = radiiSquaredZ * nZ;

            // texture coordinates for geographic imagery
            var geographicV = (latitude - geographicSouth) / (geographicNorth - geographicSouth);

            // texture coordinates for web mercator imagery
            var webMercatorV = (height - row - 1) / (height - 1);

            for ( var col = 0; col < width; ++col) {
                var longitude = extent.west + granularityX * col;
                if (!isGeographic) {
                    longitude = longitude * oneOverCentralBodySemimajorAxis;
                } else {
                    longitude = toRadians(longitude);
                }

                var terrainOffset = row * (width * stride) + col * stride;

                var heightSample;
                if (typeof bytesPerHeight === 'undefined') {
                    heightSample = heightmap[terrainOffset];
                } else {
                    heightSample = 0;
                    for (var byteOffset = 0; byteOffset < bytesPerHeight; ++byteOffset) {
                        heightSample = (heightSample << 8) + heightmap[terrainOffset + byteOffset];
                    }
                }

                heightSample = heightSample / heightScale - heightOffset;
                if (heightSample === voidIndicator) {
                    heightSample = voidFillValue;
                }

                maxHeight = Math.max(maxHeight, heightSample);
                minHeight = Math.min(minHeight, heightSample);

                //heightSample = 10000 * sin(CesiumMath.toDegrees(longitude) * 10) + 10000 * cos(CesiumMath.toDegrees(latitude) * 10);

                var nX = cosLatitude * cos(longitude);
                var nY = cosLatitude * sin(longitude);

                var kX = radiiSquaredX * nX;
                var kY = radiiSquaredY * nY;

                var gamma = sqrt((kX * nX) + (kY * nY) + (kZ * nZ));

                var rSurfaceX = kX / gamma;
                var rSurfaceY = kY / gamma;
                var rSurfaceZ = kZ / gamma;

                vertices[vertexArrayIndex++] = rSurfaceX + nX * heightSample - relativeToCenter.x;
                vertices[vertexArrayIndex++] = rSurfaceY + nY * heightSample - relativeToCenter.y;
                vertices[vertexArrayIndex++] = rSurfaceZ + nZ * heightSample - relativeToCenter.z;

                if (generateTextureCoordinates) {
                    // texture coordinates for geographic imagery
                    var geographicU = (longitude - geographicWest) / (geographicEast - geographicWest);

                    // texture coordinates for web mercator imagery
                    var webMercatorU = col / (width - 1);
                    if (interleaveTextureCoordinates) {
                        vertices[vertexArrayIndex++] = webMercatorU;
                        vertices[vertexArrayIndex++] = webMercatorV;
                        vertices[vertexArrayIndex++] = geographicU;
                        vertices[vertexArrayIndex++] = geographicV;
                    } else {
                        textureCoordinates[textureCoordinatesIndex++] = webMercatorU;
                        textureCoordinates[textureCoordinatesIndex++] = webMercatorV;
                        textureCoordinates[textureCoordinatesIndex++] = geographicU;
                        textureCoordinates[textureCoordinatesIndex++] = geographicV;
                    }
                }
            }
        }

        if (typeof indices !== 'undefined') {
            var index = 0;
            var indicesIndex = 0;
            for ( var i = 0; i < height - 1; ++i) {
                for ( var j = 0; j < width - 1; ++j) {
                    var upperLeft = index;
                    var lowerLeft = upperLeft + width;
                    var lowerRight = lowerLeft + 1;
                    var upperRight = upperLeft + 1;

                    indices[indicesIndex++] = upperLeft;
                    indices[indicesIndex++] = lowerLeft;
                    indices[indicesIndex++] = upperRight;
                    indices[indicesIndex++] = upperRight;
                    indices[indicesIndex++] = lowerLeft;
                    indices[indicesIndex++] = lowerRight;

                    ++index;
                }
                ++index;
            }
        }

        return {
            maxHeight : maxHeight,
            minHeight : minHeight
        };
    };

    /**
     * Creates a mesh from a heightmap.
     *
     * @param {Image} description.image The heightmap image.
     * @param {Number} description.heightScale DOC_TBA
     * @param {Number} description.heightOffset DOC_TBA
     * @param {Number} description.bytesPerHeight DOC_TBA
     * @param {Number} description.stride DOC_TBA
     * @param {Extent} description.extent A cartographic extent with north, south, east and west properties in radians.
     * @param {Boolean} description.generateTextureCoordinates Whether to generate texture coordinates.
     * @param {Ellipsoid} [description.ellipsoid=Ellipsoid.WGS84] The ellipsoid on which the extent lies.
     * @param {Cartesian3} [description.relativetoCenter=Cartesian3.ZERO] The positions will be computed as <code>worldPosition.subtract(relativeToCenter)</code>.
     * @param {Number} [description.granularity=0.1] The distance, in radians, between each latitude and longitude. Determines the number of positions in the buffer.
     *
     * @exception {DeveloperError} <code>description.extent</code> is required and must have north, south, east and west attributes.
     * @exception {DeveloperError} <code>description.extent.north</code> must be in the interval [<code>-Pi/2</code>, <code>Pi/2</code>].
     * @exception {DeveloperError} <code>description.extent.south</code> must be in the interval [<code>-Pi/2</code>, <code>Pi/2</code>].
     * @exception {DeveloperError} <code>description.extent.east</code> must be in the interval [<code>-Pi</code>, <code>Pi</code>].
     * @exception {DeveloperError} <code>description.extent.west</code> must be in the interval [<code>-Pi</code>, <code>Pi</code>].
     * @exception {DeveloperError} <code>description.extent.north</code> must be greater than <code>extent.south</code>.
     * @exception {DeveloperError} <code>description.extent.east</code> must be greater than <code>extent.west</code>.
     *
     * @return {Object} A mesh containing attributes for positions, possibly texture coordinates and indices from the extent for creating a vertex array.
     *
     * @see Context#createVertexArrayFromMesh
     * @see MeshFilters#createAttributeIndices
     * @see MeshFilters#toWireframeInPlace
     * @see Extent
     *
     * @example
     * // Create a vertex array for rendering a wireframe extent.
     * var mesh = HeightmapTessellator.compute({
     *     ellipsoid : Ellipsoid.WGS84,
     *     extent : new Extent(
     *         CesiumMath.toRadians(-80.0),
     *         CesiumMath.toRadians(39.0),
     *         CesiumMath.toRadians(-74.0),
     *         CesiumMath.toRadians(42.0)
     *     ),
     *     granularity : 0.01,
     *     altitude : 10000.0
     * });
     * mesh = MeshFilters.toWireframeInPlace(mesh);
     * var va = context.createVertexArrayFromMesh({
     *     mesh             : mesh,
     *     attributeIndices : MeshFilters.createAttributeIndices(mesh)
     * });
     */
    HeightmapTessellator.compute = function(description) {
        description = defaultValue(description, {});

        var extent = description.extent;
        Extent.validate(extent);

        var ellipsoid = defaultValue(description.ellipsoid, Ellipsoid.WGS84);
        description.radiiSquared = ellipsoid.getRadiiSquared();
        description.oneOverCentralBodySemimajorAxis = ellipsoid.getOneOverRadii().x;
        description.relativeToCenter = defaultValue(description.relativeToCenter, Cartesian3.ZERO);

        var image = description.image;
        description.heightmap = getImagePixels(image);
        description.width = image.width;
        description.height = image.height;

        var vertices = [];
        var indices = [];
        var textureCoordinates = [];

        description.interleaveTextureCoordinates = false;
        description.vertices = vertices;
        description.textureCoordinates = textureCoordinates;
        description.indices = indices;

        var granularity = defaultValue(description.granularity, 0.1);
        var boundaryWidth = defaultValue(description.boundaryWidth, 0); // NOTE: may want to expose in the future.

        description.boundaryExtent = new Extent(extent.west - granularity * boundaryWidth,
                                                extent.south - granularity * boundaryWidth,
                                                extent.east + granularity * boundaryWidth,
                                                extent.north + granularity * boundaryWidth);

        HeightmapTessellator.computeVertices(description);

        var mesh = {
            attributes : {},
            indexLists : [{
                primitiveType : PrimitiveType.TRIANGLES,
                values : indices
            }]
        };

        var positionName = defaultValue(description.positionName, 'position');
        mesh.attributes[positionName] = {
            componentDatatype : ComponentDatatype.FLOAT,
            componentsPerAttribute : 3,
            values : vertices
        };

        if (description.generateTextureCoordinates) {
            var textureCoordinatesName = defaultValue(description.textureCoordinatesName, 'textureCoordinates');
            mesh.attributes[textureCoordinatesName] = {
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 2,
                values : textureCoordinates
            };
        }

        return mesh;
    };

    /**
     * Creates arrays of vertex attributes and indices from a heightmap.
     *
     * @param {Ellipsoid} description.ellipsoid The ellipsoid on which the extent lies. Defaults to a WGS84 ellipsoid.
     * @param {Extent} description.extent A cartographic extent with north, south, east and west properties in radians.
     * @param {Number} description.granularity The distance, in radians, between each latitude and longitude.
     * Determines the number of positions in the buffer. Defaults to 0.1.
     * @param {Boolean} description.generateTextureCoords A truthy value will cause texture coordinates to be generated.
     * @param {Boolean} description.interleave If both this parameter and <code>generateTextureCoords</code> are truthy,
     * the positions and texture coordinates will be interleaved in a single buffer.
     * @param {Object} description.attributeIndices An object with possibly two numeric attributes, <code>position</code>
     * and <code>textureCoordinates</code>, used to index the shader attributes of the same names.
     * <code>position</code> defaults to 0 and <code>textureCoordinates</code> defaults to 1.
     * @param {Cartesian3} description.relativetoCenter If this parameter is provided, the positions will be
     * computed as <code>worldPosition.subtract(relativeToCenter)</code>. Defaults to (0, 0, 0).
     *
     * @exception {DeveloperError} <code>description.extent</code> is required and must have north, south, east and west attributes.
     * @exception {DeveloperError} <code>description.extent.north</code> must be in the interval [<code>-Pi/2</code>, <code>Pi/2</code>].
     * @exception {DeveloperError} <code>description.extent.south</code> must be in the interval [<code>-Pi/2</code>, <code>Pi/2</code>].
     * @exception {DeveloperError} <code>description.extent.east</code> must be in the interval [<code>-Pi</code>, <code>Pi</code>].
     * @exception {DeveloperError} <code>description.extent.west</code> must be in the interval [<code>-Pi</code>, <code>Pi</code>].
     * @exception {DeveloperError} <code>description.extent.north</code> must be greater than <code>extent.south</code>.     *
     * @exception {DeveloperError} <code>description.extent.east</code> must be greater than <code>extent.west</code>.
     *
     * @return {Object} An object with flattened arrays for vertex attributes and indices.
     *
     * @example
     * // Example 1:
     * // Create a vertex array for a solid extent, with separate positions and texture coordinates.
     * var buffers = HeightmapTessellator.computeBuffers({
     *     ellipsoid : ellipsoid,
     *     extent : extent,
     *     generateTextureCoords : true
     * });
     *
     * var datatype = ComponentDatatype.FLOAT;
     * var usage = BufferUsage.STATIC_DRAW;
     * var positionBuffer = context.createVertexBuffer(datatype.toTypedArray(buffers.positions), usage);
     * var texCoordBuffer = context.createVertexBuffer(datatype.toTypedArray(buffers.textureCoords), usage);
     * attributes = [{
     *         index : attributeIndices.position,
     *         vertexBuffer : positionBuffer,
     *         componentDatatype : datatype,
     *         componentsPerAttribute : 3
     *     }, {
     *         index : attributeIndices.textureCoordinates,
     *         vertexBuffer : texCoordBuffer,
     *         componentDatatype : datatype,
     *         componentsPerAttribute : 2
     *     }];
     * var indexBuffer = context.createIndexBuffer(new Uint16Array(buffers.indices), usage, IndexDatatype.UNSIGNED_SHORT);
     * var va = context.createVertexArray(attributes, indexBuffer);
     *
     * @example
     * // Example 2:
     * // Create a vertex array for a solid extent, with interleaved positions and texture coordinates.
     * var buffers = HeightmapTessellator.computeBuffers({
     *     ellipsoid : ellipsoid,
     *     extent : extent,
     *     generateTextureCoords : true,
     *     interleave : true
     * });
     *
     * var datatype = ComponentDatatype.FLOAT;
     * var usage = BufferUsage.STATIC_DRAW;
     * var typedArray = datatype.toTypedArray(buffers.vertices);
     * var buffer = context.createVertexBuffer(typedArray, usage);
     * var stride = 5 * datatype.sizeInBytes;
     * var attributes = [{
     *         index : attributeIndices.position3D,
     *         vertexBuffer : buffer,
     *         componentDatatype : datatype,
     *         componentsPerAttribute : 3,
     *         normalize : false,
     *         offsetInBytes : 0,
     *         strideInBytes : stride
     *     }, {
     *         index : attributeIndices.textureCoordinates,
     *         vertexBuffer : buffer,
     *         componentDatatype : datatype,
     *         componentsPerAttribute : 2,
     *         normalize : false,
     *         offsetInBytes : 3 * datatype.sizeInBytes,
     *         strideInBytes : stride
     *     }];
     * var indexBuffer = context.createIndexBuffer(new Uint16Array(buffers.indices), usage, IndexDatatype.UNSIGNED_SHORT);
     * var vacontext.createVertexArray(attributes, indexBuffer);
     *
     */
    HeightmapTessellator.computeBuffers = function(description) {
        var desc = description || {};

        Extent.validate(desc.extent);

        desc.ellipsoid = desc.ellipsoid || Ellipsoid.WGS84;
        desc.relativeToCenter = (desc.relativeToCenter) ? Cartesian3.clone(desc.relativeToCenter) : Cartesian3.ZERO;
        desc.boundaryWidth = desc.boundaryWidth || 0; // NOTE: may want to expose in the future.

        desc.vertices = [];
        desc.texCoords = [];
        desc.indices = [];
        desc.boundaryExtent = new Extent(
            desc.extent.west - desc.granularity * desc.boundaryWidth,
            desc.extent.south - desc.granularity * desc.boundaryWidth,
            desc.extent.east + desc.granularity * desc.boundaryWidth,
            desc.extent.north + desc.granularity * desc.boundaryWidth
        );

        HeightmapTessellator._computeVertices(desc);

        var result = {};
        if (desc.interleave) {
            result.vertices = desc.vertices;
        } else {
            result.positions = desc.vertices;
            if (desc.generateTextureCoords) {
                result.textureCoords = desc.texCoords;
            }
        }

        result.indices = desc.indices;
        return result;
    };

    return HeightmapTessellator;
});
