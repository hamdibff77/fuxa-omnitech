import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { interval, Subject, takeUntil } from 'rxjs';

import { Device, DeviceType, Tag } from '../../_models/device';
import { HmiService } from '../../_services/hmi.service';
import { ProjectService } from '../../_services/project.service';
import { DevicePropertyComponent } from '../device-property/device-property.component';

/**
 * Reusable list of the device connections (servers excluded).
 * Shows connection status, address and the configured tags and can be
 * embedded both in the editor sidebar and in the Connections settings page.
 */
@Component({
    selector: 'app-connections-list',
    templateUrl: './connections-list.component.html',
    styleUrls: ['./connections-list.component.scss']
})
export class ConnectionsListComponent implements OnInit, OnDestroy {

    @Input() expandTagsByDefault = true;
    @Output() selected: EventEmitter<Device> = new EventEmitter<Device>();

    connections: Device[] = [];
    expandedConnections: { [id: string]: boolean } = {};
    private connectionStatuses: { [id: string]: { status: string; last: number } } = {};
    private destroy$ = new Subject<void>();

    constructor(private projectService: ProjectService,
        private translateService: TranslateService,
        private hmiService: HmiService,
        public dialog: MatDialog) { }

    ngOnInit() {
        this.refreshConnections();
        this.hmiService.onDeviceChanged.pipe(
            takeUntil(this.destroy$)
        ).subscribe((event: any) => {
            if (event?.id && event?.status) {
                this.connectionStatuses[event.id] = { status: event.status, last: Date.now() };
            }
        });
        interval(10000).pipe(
            takeUntil(this.destroy$)
        ).subscribe(() => {
            this.refreshConnections();
            this.hmiService.askDeviceStatus();
        });
        this.hmiService.askDeviceStatus();
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    refreshConnections() {
        this.connections = this.projectService.getServerDevices().filter(
            device => device.type !== DeviceType.FuxaServer
        );
        this.connections.forEach(device => {
            if (this.expandedConnections[device.id] === undefined) {
                this.expandedConnections[device.id] = this.expandTagsByDefault;
            }
        });
    }

    getConnectionTags(device: Device): Tag[] {
        return Object.values(device.tags || {}).sort((left, right) =>
            (left.label || left.name || '').localeCompare(right.label || right.name || '')
        );
    }

    toggleConnectionTags(device: Device, event: Event) {
        event.stopPropagation();
        this.expandedConnections[device.id] = !this.expandedConnections[device.id];
    }

    getConnectionStatus(device: Device): string {
        if (device.enabled === false) {
            return 'connect-off';
        }
        const status = this.connectionStatuses[device.id];
        if (!status) {
            return '';
        }
        if (status.last + 15000 < Date.now() && status.status !== 'connect-off') {
            return 'connect-error';
        }
        return status.status;
    }

    getConnectionStatusColor(device: Device): string {
        const status = this.getConnectionStatus(device);
        if (status === 'connect-ok') {
            return '#00b050';
        }
        if (status === 'connect-error' || status === 'connect-failed') {
            return '#ff2d2d';
        }
        if (status === 'connect-off' || status === 'connect-busy') {
            return '#ffc000';
        }
        return '#9e9e9e';
    }

    getConnectionAddress(device: Device): string {
        const address = device.property?.address;
        if (typeof address !== 'string' || !address.trim()) {
            return '-';
        }
        const trimmedAddress = address.trim();
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmedAddress)) {
            try {
                const url = new URL(trimmedAddress);
                return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
            } catch (error) {
                console.warn(`Unable to parse connection address for ${device.name}`, error);
            }
        }
        return trimmedAddress.replace(
            /((?:password|pwd|token|secret|username|user|uid)\s*=\s*)("[^"]*"|'[^']*'|[^;\s]*)/gi,
            '$1[redacted]'
        );
    }

    onConfigureConnection(device: Device) {
        const availableType = [device.type];
        const exist = this.projectService.getDeviceList()
            .filter(existing => existing.id !== device.id)
            .map(existing => existing.name);
        const editableDevice: Device = JSON.parse(JSON.stringify(device));
        const dialogRef = this.dialog.open(DevicePropertyComponent, {
            disableClose: true,
            panelClass: 'dialog-property',
            width: '450px',
            maxWidth: 'calc(100vw - 32px)',
            data: {
                device: editableDevice,
                remove: false,
                exist,
                availableType,
                projectService: this.projectService
            },
            position: { top: '60px' }
        });

        dialogRef.afterClosed().subscribe(result => {
            if (result?.device) {
                const oldDevice: Device = JSON.parse(JSON.stringify(device));
                this.projectService.setDevice(result.device, oldDevice, result.security);
                this.refreshConnections();
                this.hmiService.askDeviceStatus();
            }
        });
    }

    onSelectDevice(device: Device) {
        this.selected.emit(device);
    }
}
