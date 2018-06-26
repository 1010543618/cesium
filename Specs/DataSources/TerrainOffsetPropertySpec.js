defineSuite([
    'DataSources/TerrainOffsetProperty',
    'Core/Cartesian3',
    'Core/Event',
    'Core/JulianDate',
    'Core/Rectangle',
    'Scene/HeightReference',
    'DataSources/ConstantProperty',
    'Specs/createGlobe',
    'Specs/createScene'
], function(
    TerrainOffsetProperty,
    Cartesian3,
    Event,
    JulianDate,
    Rectangle,
    HeightReference,
    ConstantProperty,
    createGlobe,
    createScene) {
    'use strict';

    var scene;
    var time = JulianDate.now();
    beforeAll(function() {
        scene = createScene();
        scene.globe = createGlobe();
    });

    afterAll(function() {
        scene.destroyForSpecs();
    });

    it('can construct and destroy', function() {
        var getPosition = jasmine.createSpy();
        var height = new ConstantProperty(30);
        var extrudedHeight = new ConstantProperty(0);
        var property = new TerrainOffsetProperty(scene, height, extrudedHeight, getPosition);
        expect(property.isConstant).toBe(false);
        expect(property.getValue(time)).toEqual(Cartesian3.ZERO);
        property.destroy();
        expect(property.isDestroyed()).toBe(true);
    });

    it('throws without scene', function() {
        var getPosition = jasmine.createSpy();
        var height = new ConstantProperty(30);
        var extrudedHeight = new ConstantProperty(0);
        expect(function() {
            return new TerrainOffsetProperty(undefined, height, extrudedHeight, getPosition);
        }).toThrowDeveloperError();
    });

    it('throws without height', function() {
        var getPosition = jasmine.createSpy();
        var extrudedHeight = new ConstantProperty(0);
        expect(function() {
            return new TerrainOffsetProperty(scene, undefined, extrudedHeight, getPosition);
        }).toThrowDeveloperError();
    });

    it('throws without extrudedHeight', function() {
        var getPosition = jasmine.createSpy();
        var height = new ConstantProperty(30);
        expect(function() {
            return new TerrainOffsetProperty(scene, height, undefined, getPosition);
        }).toThrowDeveloperError();
    });

    it('throws without getPosition', function() {
        var height = new ConstantProperty(30);
        var extrudedHeight = new ConstantProperty(0);
        expect(function() {
            return new TerrainOffsetProperty(scene, height, extrudedHeight, undefined);
        }).toThrowDeveloperError();
    });
});