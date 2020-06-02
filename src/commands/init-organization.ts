import { writeFileSync } from 'fs';
import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { Validator } from '~parser/validator';

const commandName = 'init <file>';
const commandDescription = 'generate template & initialize organization';

export class InitOrganizationCommand extends BaseCliCommand<IInitCommandArgs> {

    static async Perform(command: IInitCommandArgs): Promise<void> {
        const x = new InitOrganizationCommand();
        await x.performCommand(command);
    }

    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'file');
    }

    public addOptions(command: Command): void {
        command.option('--region <region>', 'region used to created state-bucket in');
        super.addOptions(command);
    }

    public async performCommand(command: IInitCommandArgs): Promise<void> {
        if (!command.region) {
            throw new OrgFormationError('argument --region is missing');
        }

        Validator.validateRegion(command.region);

        const region = command.region;
        const filePath = command.file;
        const storageProvider = await this.createOrGetStateBucket(command, region);
        const template = await this.generateDefaultTemplate();
        const templateContents = template.template;
        writeFileSync(filePath, templateContents);

        await template.state.save(storageProvider);

        ConsoleUtil.LogInfo(`Your organization template is written to ${command.file}`);
        ConsoleUtil.LogInfo('Hope this will get you started!');
        ConsoleUtil.LogInfo('');
        ConsoleUtil.LogInfo(`You can keep the ${command.file} file on disk or even better, under source control.`);
        ConsoleUtil.LogInfo('If you work with code pipeline you might find init-pipeline an interesting command too.');
        ConsoleUtil.LogInfo('');
        ConsoleUtil.LogInfo(`Don't worry about losing the ${command.file} file, at any point you can recreate it.`);
        ConsoleUtil.LogInfo('Have fun! ');
        ConsoleUtil.LogInfo('');
        ConsoleUtil.LogInfo('--OC');

    }
}

export interface IInitCommandArgs extends ICommandArgs {
    file: string;
    region: string;
}
