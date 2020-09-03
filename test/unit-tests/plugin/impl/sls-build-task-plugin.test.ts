import { SlsBuildTaskPlugin, ISlsCommandArgs } from "~plugin/impl/sls-build-task-plugin";
import { ICfnSubExpression } from "~core/cfn-expression";

describe('when creating sls plugin', () => {
    let plugin: SlsBuildTaskPlugin;

    beforeEach(() => {
        plugin = new SlsBuildTaskPlugin();
    });

    test('plugin has the right type',() => {
        expect(plugin.type).toBe('serverless.com');
    });


    test('plugin has the right type for tasks',() => {
        expect(plugin.typeForTask).toBe('update-serverless.com');
    });

    test('plugin can translate config to command args',() => {
        const commandArgs = plugin.convertToCommandArgs( {
            FilePath: './tasks.yaml',
            Type: 'cdk',
            MaxConcurrentTasks: 6,
            FailedTaskTolerance: 4,
            LogicalName: 'test-task',
            Stage: 'stage',
            Config: './config.yml',
            Path: './',
            TaskRoleName: 'TaskRole',
            OrganizationBinding: { IncludeMasterAccount: true}  },
            { organizationFile: './organization.yml'} as any);
        expect(commandArgs.name).toBe('test-task');
        expect(commandArgs.path).toBe('./');
        expect(commandArgs.stage).toBe('stage');
        expect(commandArgs.organizationFile).toBe('./organization.yml');
        expect(commandArgs.maxConcurrent).toBe(6);
        expect(commandArgs.failedTolerance).toBe(4);
        expect(commandArgs.configFile).toBe('./config.yml');
        expect(commandArgs.taskRoleName).toBe('TaskRole');
        expect(commandArgs.organizationBinding).toBeDefined();
        expect(commandArgs.organizationBinding.IncludeMasterAccount).toBe(true);
        expect(commandArgs.runNpmInstall).toBe(false);
        expect(commandArgs.customDeployCommand).toBeUndefined();
    });
});


describe('when validating task', () => {
    let plugin: SlsBuildTaskPlugin;
    let commandArgs: ISlsCommandArgs;

    beforeEach(() => {
        plugin = new SlsBuildTaskPlugin();
        commandArgs = plugin.convertToCommandArgs( {
            FilePath: './tasks.yaml',
            Type: 'update-serverless.com',
            MaxConcurrentTasks: 1,
            FailedTaskTolerance: 4,
            LogicalName: 'test-task',
            Path: './',
            Config: './README.md',
            TaskRoleName: 'TaskRole',
            OrganizationBinding: { IncludeMasterAccount: true}},
            { organizationFile: './organization.yml'} as any);
    });

    // test('CustomDeployCommand with Sub Expression throws', () => {
    //     (commandArgs as any).customDeployCommand = { 'Fn::Sub': 'expression xyz' } as ICfnSubExpression;
    //     expect( ()=> { plugin.validateCommandArgs(commandArgs) }).toThrowError(/xyz/);
    //     expect( ()=> { plugin.validateCommandArgs(commandArgs) }).toThrowError(/CustomDeployCommand/);
    // });

    // test('CustomRemoveCommand with Sub Expression throws', () => {
    //     (commandArgs as any).customRemoveCommand = { 'Fn::Sub': 'expression xyz' } as ICfnSubExpression;
    //     expect( ()=> { plugin.validateCommandArgs(commandArgs) }).toThrowError(/xyz/);
    //     expect( ()=> { plugin.validateCommandArgs(commandArgs) }).toThrowError(/CustomRemoveCommand/);
    // });
});